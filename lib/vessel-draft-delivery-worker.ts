// AL-RIFA'I — optional Vessel Draft delivery worker.
//
// The worker closes the gap between the durable queue and the single narrow
// WA-01 transport adapter. It is default-disabled by env and by the existing
// five-block delivery gate. Claiming alone never sends: the worker checks the
// gate again immediately before each `send_message`.
//
// Safety:
//   * no work unless ALRIFAI_VESSEL_DRAFT_WORKER_ENABLED=1;
//   * no send unless the env+DB kill switches, approved sender/recipient and
//     transport configuration all pass runtimeDeliveryGate();
//   * one bridge call per claimed record; no automatic resend on ambiguity;
//   * every outcome is persisted in vessel_draft_deliveries and audit_events;
//   * no financial ledger write and no WA-02 scope change.

import {
  applyDeliveryOutcomeToStore,
  claimDueDeliveries,
  deliveryRowToRecord,
  revalidateQueuedRecipient,
  runtimeDeliveryGate,
} from './standalone/vessel-draft-delivery-store.ts';
import {
  buildOutboundRequest,
  type DeliveryGateConfig,
  type DeliveryGate,
  type DraftDeliveryRecord,
} from './vessel-draft-delivery.ts';
import {
  sendVesselDraft,
  verifyVesselDraftSender,
  vesselDraftTransportPaths,
  type VesselDraftSend,
  type VesselDraftTransportPaths,
  type VesselDraftVerifySender,
} from './vessel-draft-transport.ts';

let timer: ReturnType<typeof setTimeout> | null = null;
let started = false;
let running = false;
let lastReason: string | null = null;
let lastResult: {
  at: string; claimed: number; sent: number; failed: number; unknown: number;
  disabled: boolean; reason: string | null;
} | null = null;

function intervalMs(): number {
  const raw = Number(process.env.ALRIFAI_VESSEL_DRAFT_WORKER_INTERVAL_MS ?? 5000);
  if (!Number.isFinite(raw)) return 5000;
  return Math.min(Math.max(Math.floor(raw), 1000), 300_000);
}

function limit(): number {
  const raw = Number(process.env.ALRIFAI_VESSEL_DRAFT_WORKER_LIMIT ?? 10);
  if (!Number.isFinite(raw)) return 10;
  return Math.min(Math.max(Math.floor(raw), 1), 100);
}

export type VesselDraftValidateRecipient = (
  record: DraftDeliveryRecord,
  config: DeliveryGateConfig,
) => Promise<{ok: true} | {ok: false; reason: string}>;

export type VesselDraftTickOptions = {
  limit?: number;
  transport?: VesselDraftSend;
  verifySender?: VesselDraftVerifySender;
  validateRecipient?: VesselDraftValidateRecipient;
  paths?: VesselDraftTransportPaths | null;
  gate?: {config: DeliveryGateConfig; gate: DeliveryGate};
};

export type VesselDraftTickResult = {
  claimed: number;
  sent: number;
  failed: number;
  unknown: number;
  disabled: boolean;
  reason: string | null;
};

/** Run one bounded delivery tick. Exported for isolated tests and manual smoke. */
export async function runVesselDraftDeliveryTick(
  options: VesselDraftTickOptions = {},
): Promise<VesselDraftTickResult> {
  const runtime = options.gate ?? await runtimeDeliveryGate();
  if (!runtime.gate.enabled) {
    return {
      claimed: 0, sent: 0, failed: 0, unknown: 0,
      disabled: true, reason: runtime.gate.reasons.join(',') || 'VESSEL_DRAFT_GATE_DISABLED',
    };
  }
  const paths = options.paths === undefined ? vesselDraftTransportPaths() : options.paths;
  const transport = options.transport ?? sendVesselDraft;
  const verifySender = options.verifySender ?? verifyVesselDraftSender;
  const validateRecipient = options.validateRecipient ?? revalidateQueuedRecipient;
  const claimed = await claimDueDeliveries(options.limit ?? limit());
  let sent = 0;
  let failed = 0;
  let unknown = 0;

  for (const row of claimed) {
    if (!paths) {
      await applyDeliveryOutcomeToStore(row.id, {
        kind: 'unknown',
        error: 'VESSEL_DRAFT_TRANSPORT_NOT_CONFIGURED',
      });
      unknown += 1;
      continue;
    }
    const request = buildOutboundRequest(deliveryRowToRecord(row), runtime.gate, runtime.config);
    if (!request.allowed) {
      await applyDeliveryOutcomeToStore(row.id, {
        kind: 'unknown',
        error: `VESSEL_DRAFT_REQUEST_DENIED:${request.reasons.join(',')}`.slice(0, 300),
      });
      unknown += 1;
      continue;
    }
    // Re-validate the original order conversation immediately before sending.
    // A stale or tampered row must never redirect a draft to another chat.
    const recipient = await validateRecipient(deliveryRowToRecord(row), runtime.config);
    if (!recipient.ok) {
      await applyDeliveryOutcomeToStore(row.id, {
        kind: 'failed',
        error: `VESSEL_DRAFT_RECIPIENT_INVALID:${recipient.reason}`.slice(0, 300),
      });
      failed += 1;
      continue;
    }
    // Confirm the socket/token belongs to the approved sender BEFORE any
    // message leaves the process. A mismatch or unreadable identity is a
    // bounded failure, never a send.
    const identity = await verifySender(
      runtime.config.ownerApprovedSender ?? '',
      paths,
    );
    if (!identity.ok) {
      await applyDeliveryOutcomeToStore(row.id, {
        kind: 'failed',
        error: identity.reason,
      });
      failed += 1;
      continue;
    }
    const outcome = await transport(request.request, paths);
    await applyDeliveryOutcomeToStore(row.id, outcome);
    if (outcome.kind === 'sent') sent += 1;
    else if (outcome.kind === 'failed') failed += 1;
    else unknown += 1;
  }

  return {claimed: claimed.length, sent, failed, unknown, disabled: false, reason: null};
}

async function tick(): Promise<void> {
  if (running) return;
  running = true;
  try {
    const result = await runVesselDraftDeliveryTick({limit: limit()});
    lastResult = {at: new Date().toISOString(), ...result};
    if (result.disabled) {
      if (lastReason !== result.reason) {
        lastReason = result.reason;
        console.error(`Vessel draft worker idle (${lastReason}).`);
      }
      return;
    }
    lastReason = null;
    if (result.claimed || result.sent || result.failed || result.unknown) {
      console.error(
        `Vessel draft worker tick claimed=${result.claimed} sent=${result.sent} `
        + `failed=${result.failed} unknown=${result.unknown}.`,
      );
    }
  } catch (error) {
    const code = error instanceof Error && /^[A-Z][A-Z0-9_]{3,80}$/.test(error.message)
      ? error.message
      : 'VESSEL_DRAFT_WORKER_TICK_FAILED';
    console.error(`Vessel draft worker tick failed (${code}).`);
  } finally {
    running = false;
    if (started) {
      timer = setTimeout(() => void tick(), intervalMs());
      timer.unref?.();
    }
  }
}

/** Start the optional loop. Safe to call more than once. */
export function startVesselDraftDeliveryWorker(): {
  started: boolean; reason?: string; intervalMs?: number; limit?: number;
} {
  if (process.env.ALRIFAI_VESSEL_DRAFT_WORKER_ENABLED !== '1') {
    return {started: false, reason: 'VESSEL_DRAFT_WORKER_DISABLED'};
  }
  if (started) return {started: false, reason: 'ALREADY_STARTED'};
  started = true;
  const delay = intervalMs();
  timer = setTimeout(() => void tick(), 1000);
  timer.unref?.();
  return {started: true, intervalMs: delay, limit: limit()};
}

export function stopVesselDraftDeliveryWorker(): void {
  started = false;
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
}

export function vesselDraftWorkerStatus() {
  return {
    started,
    running,
    lastReason,
    lastResult,
    enabled: process.env.ALRIFAI_VESSEL_DRAFT_WORKER_ENABLED === '1',
    intervalMs: intervalMs(),
    limit: limit(),
  };
}