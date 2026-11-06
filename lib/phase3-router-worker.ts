// Optional continuous Phase 3 router.
//
// The sync worker stores raw messages; this loop is the missing link that lets
// them travel through the shared router without a human pressing a button. It
// lives in the existing app process (one image, no extra service) and is
// default-disabled by BOTH an environment switch and the existing DB
// activation gate inside routePendingMessages().
//
// Safety:
//   * no work unless PHASE3_ROUTER_WORKER_ENABLED=1;
//   * routePendingMessages() still requires phase3_router_enabled=true and the
//     explicit per-account watermark/business-chat allowlist;
//   * the loop uses the stable automation identity, never a human session;
//   * a failed tick is logged and retried, never retried inline forever;
//   * no outbound WhatsApp sender and no automatic financial posting.

import {routePendingMessages} from './message-router.ts';
import type {Actor} from './standalone/db.ts';

const WORKER_ACTOR: Actor = {id: 'system:phase3-router-worker', role: 'ADMIN'};

let timer: ReturnType<typeof setTimeout> | null = null;
let started = false;
let running = false;
let lastReason: string | null = null;
let lastResult: {at: string; processed: number; errors: number; disabled: boolean} | null = null;

function intervalMs(): number {
  const raw = Number(process.env.PHASE3_ROUTER_WORKER_INTERVAL_MS ?? 5000);
  if (!Number.isFinite(raw)) return 5000;
  return Math.min(Math.max(Math.floor(raw), 1000), 300_000);
}

function limit(): number {
  const raw = Number(process.env.PHASE3_ROUTER_WORKER_LIMIT ?? 100);
  if (!Number.isFinite(raw)) return 100;
  return Math.min(Math.max(Math.floor(raw), 1), 500);
}

async function tick(): Promise<void> {
  if (running) return;
  running = true;
  try {
    const result = await routePendingMessages(WORKER_ACTOR, limit());
    lastResult = {
      at: new Date().toISOString(),
      processed: result.processed,
      errors: result.errors,
      disabled: Boolean(result.disabled),
    };
    if (result.disabled) {
      if (lastReason !== result.reason) {
        lastReason = result.reason ?? 'ROUTER_DISABLED';
        console.error(`Phase 3 router worker idle (${lastReason}).`);
      }
      return;
    }
    lastReason = null;
    if (result.processed || result.errors || result.instructions || result.programs) {
      console.error(
        `Phase 3 router worker tick processed=${result.processed} instructions=${result.instructions} `
        + `programs=${result.programs} errors=${result.errors}.`,
      );
    }
  } catch (error) {
    const code = error instanceof Error && /^[A-Z][A-Z0-9_]{3,80}$/.test(error.message)
      ? error.message
      : 'ROUTER_WORKER_TICK_FAILED';
    console.error(`Phase 3 router worker tick failed (${code}).`);
  } finally {
    running = false;
    if (started) {
      timer = setTimeout(() => void tick(), intervalMs());
      timer.unref?.();
    }
  }
}

/** Start the optional loop. Safe to call more than once. */
export function startPhase3RouterWorker(): {started: boolean; reason?: string; intervalMs?: number; limit?: number} {
  if (process.env.PHASE3_ROUTER_WORKER_ENABLED !== '1') {
    return {started: false, reason: 'WORKER_DISABLED'};
  }
  if (started) return {started: false, reason: 'ALREADY_STARTED'};
  started = true;
  const delay = intervalMs();
  timer = setTimeout(() => void tick(), 1000);
  timer.unref?.();
  return {started: true, intervalMs: delay, limit: limit()};
}

export function stopPhase3RouterWorker(): void {
  started = false;
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
}

export function phase3RouterWorkerStatus() {
  return {
    started,
    running,
    lastReason,
    lastResult,
    enabled: process.env.PHASE3_ROUTER_WORKER_ENABLED === '1',
    intervalMs: intervalMs(),
    limit: limit(),
  };
}
