BEGIN;

-- AL-RIFA'I — Migration 021: vessel-name consolidation (1.13.3).
-- Additive columns only; cash tables are not touched.
--
-- normalize_vessel_name() strips a leading MV / M.V. prefix, collapses
-- whitespace and uppercases. Display still adds "MV " at render time.

CREATE OR REPLACE FUNCTION public.normalize_vessel_name(raw text)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT upper(btrim(regexp_replace(
    regexp_replace(coalesce(raw, ''), '^M\.?\s*V\.?\s*', '', 'i'),
    '\s+', ' ', 'g'
  )));
$$;

ALTER TABLE public.programs
  ADD COLUMN IF NOT EXISTS mother_vessel_normalized text
  GENERATED ALWAYS AS (public.normalize_vessel_name(mother_vessel)) STORED;

ALTER TABLE public.programs
  ADD COLUMN IF NOT EXISTS lighter_vessel_normalized text
  GENERATED ALWAYS AS (public.normalize_vessel_name(lighter_vessel)) STORED;

ALTER TABLE public.vessels
  ADD COLUMN IF NOT EXISTS canonical_name text
  GENERATED ALWAYS AS (public.normalize_vessel_name(vessel_name)) STORED;

CREATE INDEX IF NOT EXISTS programs_mother_normalized
  ON public.programs (mother_vessel_normalized);
CREATE INDEX IF NOT EXISTS programs_lighter_normalized
  ON public.programs (lighter_vessel_normalized);
CREATE INDEX IF NOT EXISTS vessels_canonical
  ON public.vessels (vessel_type, canonical_name);

-- Consolidate the register's stored names to the canonical form. Without this
-- the display is consistent but every future filter still has to scan variants.
UPDATE public.programs
   SET mother_vessel = public.normalize_vessel_name(mother_vessel)
 WHERE mother_vessel <> public.normalize_vessel_name(mother_vessel);

UPDATE public.programs
   SET lighter_vessel = public.normalize_vessel_name(lighter_vessel)
 WHERE lighter_vessel <> public.normalize_vessel_name(lighter_vessel);

-- Deduplicate the suggestion directory before rewriting its key. Keep the
-- lexicographically first name for each canonical/role pair.
DELETE FROM public.vessels v
 USING public.vessels keep
 WHERE v.vessel_type = keep.vessel_type
   AND v.canonical_name = keep.canonical_name
   AND v.vessel_name > keep.vessel_name;

UPDATE public.vessels
   SET vessel_name = canonical_name
 WHERE vessel_name <> canonical_name;

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

UPDATE public.schema_meta SET value = '1.13.3' WHERE key = 'schema_version';

COMMIT;
