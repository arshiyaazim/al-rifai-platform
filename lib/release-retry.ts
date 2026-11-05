// Retry policy for the release/food-bill evidence pass.
//
// The ingestion checkpoint advances as soon as a page is read, so a transient
// failure inside the release hook must not be lost until the group happens to
// receive another message. The pass is idempotent (persistRows uses
// ON CONFLICT DO NOTHING and the candidate dedupe index), so a retry is safe.
//
// This module is the pure state machine; the worker owns the timer.
// Pure functions: no clock, no I/O.

export type ReleaseScanRetryState = {
  attempts: number;
  nextAttemptAt: number | null;
  lastFailureAt: number | null;
};

export const RELEASE_RETRY_BASE_MS = 60_000;
export const RELEASE_RETRY_MAX_MS = 30 * 60_000;

export const initialReleaseRetry = (): ReleaseScanRetryState => ({attempts: 0, nextAttemptAt: null, lastFailureAt: null});

/** 1 min, 2 min, 4 min … capped at 30 min. */
export function releaseRetryDelay(attempts: number): number {
  const safe = Number.isFinite(attempts) ? Math.max(0, Math.floor(attempts)) : 0;
  return Math.min(RELEASE_RETRY_BASE_MS * 2 ** Math.min(safe, 10), RELEASE_RETRY_MAX_MS);
}

export function recordReleaseScanFailure(
  state: ReleaseScanRetryState,
  now: number,
): ReleaseScanRetryState {
  const attempts = state.attempts + 1;
  return {attempts, nextAttemptAt: now + releaseRetryDelay(attempts - 1), lastFailureAt: now};
}

export function recordReleaseScanSuccess(): ReleaseScanRetryState {
  return initialReleaseRetry();
}

/** True when a retry is pending and due. A clean state never retries. */
export function shouldAttemptReleaseScan(state: ReleaseScanRetryState, now: number): boolean {
  return state.nextAttemptAt !== null && now >= state.nextAttemptAt;
}
