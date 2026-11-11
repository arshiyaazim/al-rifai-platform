BEGIN;

-- AL-RIFA'I — Migration 019: Vessel cleanup (1.13.1).
-- 1) Store vessel names without the display prefix. The renderer adds "MV ".
-- 2) Seed the confirmation shadow-mode flag (default off).
-- Cash tables are not touched.

UPDATE programs
   SET mother_vessel = regexp_replace(mother_vessel, '^M\.?\s*V\.?\s+', '', 'i'),
       lighter_vessel = regexp_replace(lighter_vessel, '^M\.?\s*V\.?\s+', '', 'i')
 WHERE mother_vessel ~* '^M\.?\s*V\.?\s+'
    OR lighter_vessel ~* '^M\.?\s*V\.?\s+';

INSERT INTO system_feature_flags (key, enabled, config)
VALUES ('vessel.auto_confirm.shadow', false, '{}')
ON CONFLICT (key) DO NOTHING;

UPDATE schema_meta SET value = '1.13.1' WHERE key = 'schema_version';

COMMIT;
