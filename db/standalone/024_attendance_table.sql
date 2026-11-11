BEGIN;

-- AL-RIFA'I — Migration 024: attendance records (1.13.6).
--
-- The installation already has an `attendance` table (439 PRESENT rows) used by
-- the legacy employee page. This migration adds the owner-specified
-- `attendance_records` table and backfills legacy rows that are NOT already
-- covered by vessel duty, so the unified view does not double-count.

CREATE TABLE IF NOT EXISTS public.attendance_records (
  id text PRIMARY KEY DEFAULT 'att_' || gen_random_uuid()::text,
  employee_mobile text NOT NULL
    REFERENCES public.employees(employee_mobile) ON DELETE RESTRICT,
  attendance_date date NOT NULL,
  shift text NOT NULL CHECK (shift IN ('D','N','FULL')),
  location text,
  client_name text,
  designation text,
  remarks text,
  created_by text,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  state text NOT NULL DEFAULT 'ACTIVE' CHECK (state IN ('ACTIVE','VOIDED')),
  UNIQUE (employee_mobile, attendance_date, shift)
);

CREATE INDEX IF NOT EXISTS idx_attendance_employee
  ON public.attendance_records (employee_mobile);
CREATE INDEX IF NOT EXISTS idx_attendance_date
  ON public.attendance_records (attendance_date);
CREATE INDEX IF NOT EXISTS idx_attendance_employee_date
  ON public.attendance_records (employee_mobile, attendance_date, shift);

INSERT INTO public.attendance_records
  (id, employee_mobile, attendance_date, shift, location, designation,
   remarks, created_by, created_at, updated_at, state)
SELECT 'legacy_' || a.id, a.employee_mobile, a.duty_date, a.shift::text,
       NULL, e.designation, 'Backfilled from legacy attendance',
       'migration:024', a.created_at, now(), 'ACTIVE'
  FROM public.attendance a
  JOIN public.employees e ON e.employee_mobile = a.employee_mobile
 WHERE a.state = 'PRESENT'
   AND NOT EXISTS (
     SELECT 1
       FROM public.program_assignments pa
       JOIN public.programs p ON p.id = pa.program_id
      WHERE pa.employee_mobile = a.employee_mobile
        AND p.state IN ('CONFIRMED','RELEASED')
        AND a.duty_date BETWEEN p.start_date AND coalesce(p.end_date, p.start_date)
   )
ON CONFLICT (employee_mobile, attendance_date, shift) DO NOTHING;

UPDATE public.schema_meta SET value = '1.13.6' WHERE key = 'schema_version';

COMMIT;
