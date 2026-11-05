// Server start hook. Live Cash continuation must run from boot, not only after
// the first candidate-API request; otherwise the projection stays dormant while
// the ingestion worker keeps storing messages.
//
// Failure here is logged and never blocks the web server: the Cash projection is
// review-only and re-runs on the next boot.
export async function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  try {
    const { bootstrapLiveCashSync } = await import('./candidates/identity-review/host');
    const result = await bootstrapLiveCashSync();
    if (result.started) {
      console.error('Live Cash continuation started (review-only).');
    } else {
      console.error(`Live Cash continuation not started (${result.reason ?? 'UNKNOWN'}).`);
    }
  } catch (error) {
    const code = error instanceof Error && /^[A-Z][A-Z0-9_]{3,80}$/.test(error.message) ? error.message : 'LIVE_CASH_BOOTSTRAP_FAILED';
    console.error(`Live Cash continuation bootstrap failed (${code}).`);
  }
}
