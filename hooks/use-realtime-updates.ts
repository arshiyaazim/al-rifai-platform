'use client';

import {useEffect, useRef, useState} from 'react';

export type RealtimeDomain = 'CASH' | 'VESSEL' | 'MESSAGE' | 'REVIEW' | 'ANY';
export type RealtimeStatus = 'connecting' | 'live' | 'reconnecting' | 'polling';

export type RealtimeEvent = {
  domain: RealtimeDomain;
  action: string;
  id: string | null;
  at: string;
};

type Listener = (event: RealtimeEvent) => void;
type StatusListener = (status: RealtimeStatus) => void;

const listeners = new Set<Listener>();
const statusListeners = new Set<StatusListener>();
let source: EventSource | null = null;
let started = false;
let status: RealtimeStatus = 'connecting';
let failures = 0;
let pollTimer: number | null = null;

function publish(next: RealtimeStatus) {
  if (status === next) return;
  status = next;
  for (const listener of statusListeners) listener(next);
}

function emit(event: RealtimeEvent) {
  for (const listener of listeners) listener(event);
}

function startPolling() {
  if (pollTimer !== null) return;
  pollTimer = window.setInterval(() => {
    emit({domain: 'ANY', action: 'POLL', id: null, at: new Date().toISOString()});
  }, 30_000);
}

function stopPolling() {
  if (pollTimer === null) return;
  window.clearInterval(pollTimer);
  pollTimer = null;
}

function connect() {
  if (typeof window === 'undefined') return;
  if (typeof EventSource === 'undefined') {
    publish('polling');
    startPolling();
    return;
  }
  source?.close();
  publish('connecting');
  try {
    source = new EventSource('/api/events');
  } catch {
    publish('polling');
    startPolling();
    return;
  }
  source.addEventListener('open', () => {
    failures = 0;
    stopPolling();
    publish('live');
  });
  source.addEventListener('domain', (message) => {
    try {
      const payload = JSON.parse((message as MessageEvent).data) as RealtimeEvent;
      if (payload && typeof payload.domain === 'string') emit(payload);
    } catch {
      // Ignore malformed events; the next valid event will refresh.
    }
  });
  source.addEventListener('error', () => {
    failures += 1;
    if (failures >= 3) {
      source?.close();
      source = null;
      publish('polling');
      startPolling();
      console.warn('[realtime] SSE unavailable after 3 attempts; falling back to 30s polling for this session.');
      return;
    }
    publish('reconnecting');
    // Automatic fallback while the browser retries the stream.
    startPolling();
  });
}

function ensureStarted() {
  if (started || typeof window === 'undefined') return;
  started = true;
  connect();
}

/**
 * Shared SSE subscription. Only one EventSource is opened per browser tab,
 * regardless of how many components ask for updates. On disconnect the hook
 * falls back to the original 30-second polling cadence; after three
 * consecutive failures it stays on polling for the rest of the session.
 */
export function useRealtimeUpdates(
  domain: RealtimeDomain,
  onEvent: () => void,
  options: {enabled?: boolean} = {},
) {
  const callback = useRef(onEvent);
  useEffect(() => { callback.current = onEvent; }, [onEvent]);
  const [currentStatus, setCurrentStatus] = useState<RealtimeStatus>(status);
  const enabled = options.enabled !== false;

  useEffect(() => {
    const onStatus: StatusListener = (next) => setCurrentStatus(next);
    statusListeners.add(onStatus);
    if (!enabled) {
      publish('polling');
      startPolling();
      return () => {
        statusListeners.delete(onStatus);
      };
    }

    ensureStarted();
    let timer: number | null = null;
    const listener: Listener = (event) => {
      if (event.action === 'POLL' || event.domain === domain || event.domain === 'ANY') {
        if (timer !== null) window.clearTimeout(timer);
        timer = window.setTimeout(() => callback.current(), 500);
      }
    };
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
      statusListeners.delete(onStatus);
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [domain, enabled]);

  return {status: currentStatus, isLive: currentStatus === 'live'};
}
