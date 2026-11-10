BEGIN;

-- AL-RIFA'I — Migration 020: Phase 3 vessel/review overhaul (1.13.2).
-- Additive only; cash tables are NOT touched.
--
-- 1) rate_config fallback uses the real wildcard row ('*') instead of 'default'
-- 2) programs gains WITHDRAWN for superseded escort-change rows
-- 3) programs_exact_identity is dropped: escort changes may share the same
--    mother/lighter/start date and the six-field engine decides duplicates
-- 4) review_items gains IGNORED / SENT_BACK
-- 5) vessels reference table + seed from the existing register

-- ── 1. Derived pay: wildcard destination ────────────────────────────────────
CREATE OR REPLACE FUNCTION public.compute_program_pay(p_program_id text) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  p record; v_shifts integer; v_rate bigint; v_conv bigint; v_key text;
BEGIN
  SELECT * INTO p FROM programs WHERE id = p_program_id;
  IF NOT FOUND THEN RETURN; END IF;
  IF p.end_date IS NULL THEN
    INSERT INTO program_pay (program_id, state, reasons)
    VALUES (p_program_id, 'UNRESOLVED', '["END_DATE_REQUIRED"]'::jsonb)
    ON CONFLICT (program_id) DO UPDATE
      SET shifts = NULL, salary_minor = NULL, conveyance_minor = NULL,
          total_minor = NULL, state = 'UNRESOLVED',
          reasons = '["END_DATE_REQUIRED"]'::jsonb, computed_at = now();
    RETURN;
  END IF;
  v_shifts := (p.end_date - p.start_date) * 2
              + (CASE WHEN p.end_shift = 'N' THEN 1 ELSE 0 END)
              - (CASE WHEN p.start_shift = 'N' THEN 1 ELSE 0 END) + 1;
  IF v_shifts < 1 THEN
    INSERT INTO program_pay (program_id, state, reasons)
    VALUES (p_program_id, 'UNRESOLVED', '["INVALID_DATE_RANGE"]'::jsonb)
    ON CONFLICT (program_id) DO UPDATE
      SET shifts = NULL, salary_minor = NULL, conveyance_minor = NULL,
          total_minor = NULL, state = 'UNRESOLVED',
          reasons = '["INVALID_DATE_RANGE"]'::jsonb, computed_at = now();
    RETURN;
  END IF;
  v_key := coalesce(nullif(lower(btrim(p.destination)), ''), 'default');
  SELECT shift_rate_minor, conveyance_minor INTO v_rate, v_conv
    FROM rate_config
   WHERE destination_key = v_key AND active AND effective_from <= p.start_date
   ORDER BY effective_from DESC LIMIT 1;
  IF v_rate IS NULL THEN
    -- The wildcard row is stored as '*' (the historical seed), not 'default'.
    SELECT shift_rate_minor, conveyance_minor INTO v_rate, v_conv
      FROM rate_config
     WHERE destination_key = '*' AND active AND effective_from <= p.start_date
     ORDER BY effective_from DESC LIMIT 1;
  END IF;
  IF v_rate IS NULL THEN
    INSERT INTO program_pay (program_id, shifts, state, reasons)
    VALUES (p_program_id, v_shifts, 'UNRESOLVED', '["NO_RATE_CONFIGURED"]'::jsonb)
    ON CONFLICT (program_id) DO UPDATE
      SET shifts = EXCLUDED.shifts, salary_minor = NULL, conveyance_minor = NULL,
          total_minor = NULL, state = 'UNRESOLVED',
          reasons = '["NO_RATE_CONFIGURED"]'::jsonb, computed_at = now();
    RETURN;
  END IF;
  INSERT INTO program_pay (program_id, shifts, salary_minor, conveyance_minor, total_minor, state, reasons, computed_at)
  VALUES (p_program_id, v_shifts, v_shifts * v_rate, coalesce(v_conv, 0), v_shifts * v_rate + coalesce(v_conv, 0), 'CALCULATED', '[]'::jsonb, now())
  ON CONFLICT (program_id) DO UPDATE
    SET shifts = EXCLUDED.shifts, salary_minor = EXCLUDED.salary_minor,
        conveyance_minor = EXCLUDED.conveyance_minor, total_minor = EXCLUDED.total_minor,
        state = 'CALCULATED', reasons = '[]'::jsonb, computed_at = now();
END $$;

DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT program_id FROM public.program_pay
            WHERE reasons @> '["NO_RATE_CONFIGURED"]'::jsonb
  LOOP
    PERFORM public.compute_program_pay(r.program_id);
  END LOOP;
END $$;

-- ── 2. programs state: WITHDRAWN ────────────────────────────────────────────
ALTER TABLE public.programs DROP CONSTRAINT IF EXISTS programs_state_check;
ALTER TABLE public.programs ADD CONSTRAINT programs_state_check
  CHECK (state IN ('DRAFT','CONFIRMED','ASSIGNED','IN_DUTY','RELEASED','COMPLETED','VOIDED','WITHDRAWN'));

-- A superseded escort-change row keeps its identity visible in the register;
-- the app-level six-field engine is the duplicate authority from now on.
DROP INDEX IF EXISTS public.programs_exact_identity;

-- ── 3. review_items state machine ───────────────────────────────────────────
ALTER TABLE public.review_items DROP CONSTRAINT IF EXISTS review_items_state_check;
ALTER TABLE public.review_items ADD CONSTRAINT review_items_state_check
  CHECK (state IN ('PENDING','APPROVED','REJECTED','IGNORED','SENT_BACK','WITHDRAWN'));

-- ── 4. vessel reference table ───────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.vessels (
  vessel_name text NOT NULL CHECK (length(btrim(vessel_name)) BETWEEN 1 AND 120),
  vessel_type text NOT NULL CHECK (vessel_type IN ('mother','lighter')),
  created_by  text NOT NULL DEFAULT 'system',
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (vessel_name, vessel_type)
);

INSERT INTO public.vessels (vessel_name, vessel_type, created_by)
SELECT DISTINCT btrim(mother_vessel), 'mother', 'system'
  FROM public.programs
 WHERE btrim(mother_vessel) <> '' AND state <> 'VOIDED'
ON CONFLICT DO NOTHING;

INSERT INTO public.vessels (vessel_name, vessel_type, created_by)
SELECT DISTINCT btrim(lighter_vessel), 'lighter', 'system'
  FROM public.programs
 WHERE btrim(lighter_vessel) <> '' AND state <> 'VOIDED'
ON CONFLICT DO NOTHING;

UPDATE public.schema_meta SET value = '1.13.2' WHERE key = 'schema_version';

COMMIT;
