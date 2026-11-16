-- 029: pg_trgm support for fuzzy employee search.
-- The live database already received these objects during Phase E2.1; this
-- file records them so a fresh install and the migration ledger agree.
-- Idempotent: safe to run again. Append-only migration, no downgrade here.
-- No schema_version bump: migration 028 did not bump it either (stays 1.13.8).

BEGIN;

CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX IF NOT EXISTS idx_emp_name_trgm
  ON public.employees USING gin (preferred_name gin_trgm_ops);

CREATE INDEX IF NOT EXISTS idx_emp_mobile_trgm
  ON public.employees USING gin (employee_mobile gin_trgm_ops);

COMMIT;
