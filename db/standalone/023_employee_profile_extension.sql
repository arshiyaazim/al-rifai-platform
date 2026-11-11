BEGIN;

-- AL-RIFA'I — Migration 023: employee profile extension (1.13.5).
-- Additive columns only; vessel/cash table schemas are not changed.
-- designation and notes already exist in the baseline and are left untouched.

ALTER TABLE public.employees
  ADD COLUMN IF NOT EXISTS date_of_join date,
  ADD COLUMN IF NOT EXISTS alt_mobile text
    CHECK (alt_mobile IS NULL OR alt_mobile ~ '^\+?8801[3-9][0-9]{8}$'),
  ADD COLUMN IF NOT EXISTS home_phone text,
  ADD COLUMN IF NOT EXISTS present_address text,
  ADD COLUMN IF NOT EXISTS permanent_address text,
  ADD COLUMN IF NOT EXISTS reference_name text,
  ADD COLUMN IF NOT EXISTS reference_mobile text,
  ADD COLUMN IF NOT EXISTS nid_number text,
  ADD COLUMN IF NOT EXISTS birth_cert_number text,
  ADD COLUMN IF NOT EXISTS passport_number text;

-- Keep the historical joined_on value as the first date_of_join, without
-- removing or renaming the existing column.
UPDATE public.employees
   SET date_of_join = joined_on
 WHERE date_of_join IS NULL AND joined_on IS NOT NULL;

CREATE INDEX IF NOT EXISTS employees_designation ON public.employees (designation);
CREATE INDEX IF NOT EXISTS employees_date_of_join ON public.employees (date_of_join);

UPDATE public.schema_meta SET value = '1.13.5' WHERE key = 'schema_version';

COMMIT;
