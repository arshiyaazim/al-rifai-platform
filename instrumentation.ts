// Server start hook. The optional Phase 3 router runs from boot so newly
// ingested rows can reach the shared domain services without a manual API call.
// It is default-disabled by env and by the database activation gate.
//
// Failure here is logged and never blocks the web server; a later tick retries.
export async function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  try {
    // Load the central `.env` before any request handler builds a pool. In a
    // container the keys are already present as environment variables, so this
    // is a no-op there and never overwrites them.
    const {loadEnv} = await import('./lib/env.mjs');
    loadEnv();
  } catch (error) {
    console.error(`Configuration load failed (${error instanceof Error ? error.message : 'ENV_LOAD_FAILED'}).`);
  }
  try {
    // The optional continuous Phase 3 router. It is default-disabled by env and
    // by the database activation gate; when enabled it lets newly ingested
    // WhatsApp rows reach the same domain services the manual route endpoint
    // uses, without adding another container or a second business path.
    const {startPhase3RouterWorker} = await import('./lib/phase3-router-worker.ts');
    const worker = startPhase3RouterWorker();
    if (worker.started) {
      console.error(`Phase 3 router worker started (interval=${worker.intervalMs}ms, limit=${worker.limit}).`);
    } else {
      console.error(`Phase 3 router worker not started (${worker.reason ?? 'UNKNOWN'}).`);
    }
  } catch (error) {
    const code = error instanceof Error && /^[A-Z][A-Z0-9_]{3,80}$/.test(error.message) ? error.message : 'PHASE3_ROUTER_WORKER_FAILED';
    console.error(`Phase 3 router worker bootstrap failed (${code}).`);
  }
}
