BEGIN;

-- AL-RIFA'I — Migration 022: strip trailing cargo annotations from vessel names.
--
-- "TOURAN (WHEAT IN BULK)" and "TOURAN" are the same vessel; the parenthetical
-- suffix is cargo, not identity. Cash tables are not touched.

CREATE OR REPLACE FUNCTION public.normalize_vessel_name(raw text)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT upper(btrim(regexp_replace(
    regexp_replace(
      regexp_replace(coalesce(raw, ''), '^M\.?\s*V\.?\s*', '', 'i'),
      '\s*\(.*?\)\s*$', '', 'g'
    ),
    '\s+', ' ', 'g'
  )));
$$;

-- Remove directory duplicates that collapse to the same canonical name before
-- rewriting the primary key.
DELETE FROM public.vessels v
 USING public.vessels keep
 WHERE v.vessel_type = keep.vessel_type
   AND v.vessel_name > keep.vessel_name
   AND public.normalize_vessel_name(v.vessel_name) = public.normalize_vessel_name(keep.vessel_name);

UPDATE public.vessels
   SET vessel_name = public.normalize_vessel_name(vessel_name)
 WHERE vessel_name <> public.normalize_vessel_name(vessel_name);

UPDATE public.programs
   SET mother_vessel = public.normalize_vessel_name(mother_vessel)
 WHERE mother_vessel <> public.normalize_vessel_name(mother_vessel);

UPDATE public.programs
   SET lighter_vessel = public.normalize_vessel_name(lighter_vessel)
 WHERE lighter_vessel <> public.normalize_vessel_name(lighter_vessel);

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

UPDATE public.schema_meta SET value = '1.13.4' WHERE key = 'schema_version';

COMMIT;
