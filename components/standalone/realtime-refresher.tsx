'use client';

import {useRouter} from 'next/navigation';
import {useRealtimeUpdates, type RealtimeDomain} from '@/hooks/use-realtime-updates';

/**
 * Refreshes a server-rendered page when a matching domain event arrives.
 * The 30-second polling fallback is provided by the shared hook itself.
 */
export function RealtimeRefresher({domain, label = 'Live'}: {domain: RealtimeDomain; label?: string}) {
  const router = useRouter();
  const {status} = useRealtimeUpdates(domain, () => router.refresh());
  return <RealtimeIndicator status={status} label={label} />;
}

export function RealtimeIndicator({status, label = 'Live'}: {
  status: 'connecting' | 'live' | 'reconnecting' | 'polling';
  label?: string;
}) {
  const copy = status === 'live'
    ? label
    : status === 'reconnecting'
      ? 'Reconnecting…'
      : status === 'polling'
        ? 'Polling (fallback)'
        : 'Connecting…';
  return (
    <span className={`realtime-status realtime-status--${status}`} aria-live="polite" title={copy}>
      <span className="realtime-status__dot" aria-hidden="true" />
      {copy}
    </span>
  );
}
