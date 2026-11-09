import {EventEmitter} from 'node:events';

export type RealtimeDomain = 'CASH' | 'VESSEL' | 'MESSAGE' | 'REVIEW' | 'ANY';

export type RealtimeEvent = {
  domain: RealtimeDomain;
  action: string;
  id: string | null;
  at: string;
};

type RealtimeGlobal = typeof globalThis & {
  __alrifaiRealtimeEmitter?: EventEmitter;
  __alrifaiMessageWatcher?: NodeJS.Timeout;
};

const shared = globalThis as RealtimeGlobal;

/**
 * One in-process emitter per Node process. Stored on `globalThis` so every
 * route bundle in the standalone server shares the same instance (Next can
 * otherwise duplicate module state between route entry points).
 */
export function realtimeEmitter(): EventEmitter {
  if (!shared.__alrifaiRealtimeEmitter) {
    const emitter = new EventEmitter();
    emitter.setMaxListeners(0);
    shared.__alrifaiRealtimeEmitter = emitter;
  }
  return shared.__alrifaiRealtimeEmitter;
}

/** Broadcast after a successful mutation. The payload is deliberately small. */
export function emitDomainEvent(domain: RealtimeDomain, action: string, id?: string | null) {
  realtimeEmitter().emit('event', {
    domain,
    action,
    id: id ?? null,
    at: new Date().toISOString(),
  } satisfies RealtimeEvent);
}

export function subscribeRealtime(listener: (event: RealtimeEvent) => void): () => void {
  const emitter = realtimeEmitter();
  emitter.on('event', listener);
  return () => emitter.off('event', listener);
}

/**
 * The sync worker is a separate process, so an in-process emitter cannot see
 * its writes. A lightweight database watermark turns new mirrored messages
 * into MESSAGE:NEW events for every connected browser.
 */
export function startMessageWatcher(intervalMs = 10_000) {
  if (shared.__alrifaiMessageWatcher) return;
  let lastId: string | null = null;
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const {row} = await import('@/lib/standalone/db');
      const latest = await row<{id: string}>(
        "SELECT max(id)::text AS id FROM whatsapp_messages",
      ) ?? null;
      const next = latest?.id ?? null;
      if (lastId !== null && next !== null && next !== lastId) {
        emitDomainEvent('MESSAGE', 'NEW', next);
      }
      if (next) lastId = next;
    } catch {
      // A transient database error must never break the SSE stream.
    } finally {
      running = false;
    }
  };
  void tick();
  shared.__alrifaiMessageWatcher = setInterval(() => { void tick(); }, intervalMs);
  // Do not hold the process open in tests or during shutdown.
  shared.__alrifaiMessageWatcher.unref?.();
}
