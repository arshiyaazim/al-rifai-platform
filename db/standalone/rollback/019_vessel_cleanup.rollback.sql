BEGIN;

-- AL-RIFA'I — Rollback for migration 019.
-- Restores the display prefix on stored vessel names (all rows had "MV " before
-- 019; the exact original prefix variant is not recoverable, so "MV " is used)
-- and removes the shadow-mode flag. Cash tables are not touched.

UPDATE programs SET mother_vessel = 'MV ' || mother_vessel
 WHERE mother_vessel !~* '^M\.?\s*V\.?\s+';
UPDATE programs SET lighter_vessel = 'MV ' || lighter_vessel
 WHERE lighter_vessel !~* '^M\.?\s*V\.?\s+';

DELETE FROM system_feature_flags WHERE key = 'vessel.auto_confirm.shadow';

UPDATE schema_meta SET value = '1.13.0' WHERE key = 'schema_version';

COMMIT;
