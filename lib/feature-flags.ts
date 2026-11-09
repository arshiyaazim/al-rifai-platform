// Runtime feature flags (hot-toggle). Env flags remain only for freeze/unfreeze.
// Every new vessel behavior reads this table; a missing row falls back safely.

import {row} from './standalone/db.ts';

export type FeatureFlagRow = {
  key: string;
  enabled: boolean;
  config: Record<string, unknown> | null;
};

export async function getFeatureFlag(
  key: string,
  fallback: {enabled?: boolean; config?: Record<string, unknown>} = {},
): Promise<FeatureFlagRow> {
  const found = await row<{key: string; enabled: boolean; config: Record<string, unknown> | null}>(
    'SELECT key, enabled, config FROM system_feature_flags WHERE key = $1',
    [key],
  ).catch(() => null);
  return {
    key,
    enabled: found?.enabled ?? fallback.enabled ?? false,
    config: found?.config ?? fallback.config ?? {},
  };
}

export async function isFeatureEnabled(key: string, fallback = false): Promise<boolean> {
  return (await getFeatureFlag(key, {enabled: fallback})).enabled;
}

export async function featureConfig<T extends Record<string, unknown>>(
  key: string,
  fallback: T,
): Promise<T> {
  const flag = await getFeatureFlag(key, {config: fallback});
  return {...fallback, ...(flag.config ?? {})} as T;
}
