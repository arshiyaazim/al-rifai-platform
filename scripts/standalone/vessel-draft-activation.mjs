#!/usr/bin/env node
// AL-RIFA'I — controlled Vessel Draft delivery preflight / enqueue / tick.
//
// Read-only unless an explicit confirmation flag is present:
//
//   node --experimental-strip-types scripts/standalone/vessel-draft-activation.mjs
//   node ... --verify-sender
//   node ... --enqueue --program=<program-id> --confirm-enqueue
//   node ... --tick --limit=1 --confirm-send
//
// `--tick` performs a real WA-01 send when the full five-block gate is enabled
// and the bridge token actually has `messages.send`. It exists for the single
// Owner-approved controlled message only. Nothing here enables a switch.
//
// Identities are masked unless `--show-identities` is passed, and no token,
// password or message body is ever printed.

import {loadEnv} from '../../lib/env.mjs';

loadEnv();

const has = (name) => process.argv.includes(`--${name}`);
const arg = (name, fallback = undefined) => {
  const prefix = `--${name}=`;
  const inline = process.argv.find((value) => value.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
};

const SHOW = has('show-identities');
const mask = (jid) => {
  const value = String(jid ?? '').trim();
  if (!value || SHOW) return value || null;
  const at = value.indexOf('@');
  if (at < 0) return value.length > 4 ? `${value.slice(0, 2)}…${value.slice(-2)}` : '…';
  const local = value.slice(0, at);
  const domain = value.slice(at);
  if (local.length <= 4) return `…${domain}`;
  return `${local.slice(0, 4)}…${local.slice(-2)}${domain}`;
};

async function main() {
  const {row, rows} = await import('../../lib/standalone/db.ts');
  const {
    deliveryTableAvailable,
    runtimeDeliveryConfig,
    deliveryStatusForPrograms,
  } = await import('../../lib/standalone/vessel-draft-delivery-store.ts');
  const {deliveryGate} = await import('../../lib/vessel-draft-delivery.ts');
  const {ownerDraftFromProgram} = await import('../../lib/order-draft-from-record.ts');
  const {resolveDraftRecipient} = await import('../../lib/standalone/vessel-draft-recipient.ts');
  const {verifyVesselDraftSender, vesselDraftTransportPaths} = await import('../../lib/vessel-draft-transport.ts');

  const config = await runtimeDeliveryConfig();
  const gate = deliveryGate(config);
  const table = await deliveryTableAvailable();

  const stateCounts = table
    ? await rows(
        'SELECT state, count(*)::int AS count FROM vessel_draft_deliveries GROUP BY state ORDER BY state',
      )
    : [];
  const totals = stateCounts.reduce((sum, entry) => sum + Number(entry.count), 0);

  const base = {
    database: process.env.PGDATABASE ?? null,
    schemaTable: table ? 'present' : 'absent',
    mode: gate.mode,
    gateEnabled: gate.enabled,
    gateReasons: gate.reasons,
    deliveryRows: totals,
    deliveryStates: stateCounts,
  };

  let sender = null;
  if (has('verify-sender')) {
    const paths = vesselDraftTransportPaths();
    if (!paths) {
      sender = {ok: false, reason: 'VESSEL_DRAFT_TRANSPORT_NOT_CONFIGURED'};
    } else if (!config.ownerApprovedSender) {
      sender = {ok: false, reason: 'VESSEL_DRAFT_SENDER_NOT_APPROVED'};
    } else {
      const result = await verifyVesselDraftSender(config.ownerApprovedSender, paths);
      sender = {
        ok: result.ok,
        reason: result.ok ? null : result.reason,
        observed: mask(result.observed),
      };
    }
  }

  const programs = await rows(
    `SELECT id, mother_vessel, lighter_vessel, master_mobile, destination,
            start_date, start_shift, state, source_message_id, source_chat_jid,
            created_at::text AS created_at
       FROM programs
      WHERE state = 'DRAFT'
      ORDER BY created_at DESC
      LIMIT $1`,
    [Math.min(Math.max(Number(arg('limit', '10')) || 10, 1), 50)],
  );
  const plan = [];
  for (const program of programs) {
    const draft = ownerDraftFromProgram(program);
    const resolution = draft.text
      ? await resolveDraftRecipient({
          programId: program.id,
          sourceMessageId: program.source_message_id,
          sourceChatJid: program.source_chat_jid,
          explicitRecipient: config.ownerApprovedRecipient,
        })
      : {status: 'BLOCKED', reason: `DRAFT_INCOMPLETE:${draft.gaps.join(',')}`};
    plan.push({
      programId: program.id,
      created: program.created_at,
      draftComplete: Boolean(draft.text),
      resolution: resolution.status,
      recipient: resolution.status === 'RESOLVED' ? mask(resolution.recipientJid) : null,
      basis: resolution.status === 'RESOLVED' ? resolution.basis : null,
      reason: resolution.status === 'RESOLVED' ? null : resolution.reason,
    });
  }

  console.log(JSON.stringify({
    ...base,
    senderVerification: sender,
    pendingDrafts: programs.length,
    candidatePlan: plan,
    approvalsRequired: {
      outboundEnv: config.envEnabled,
      outboundDb: config.dbEnabled,
      sender: mask(config.ownerApprovedSender),
      pinnedRecipient: mask(config.ownerApprovedRecipient),
      authorizedAdminCount: (config.authorizedAdminJids ?? []).length,
      transportConfigured: config.transportConfigured,
    },
  }, null, 2));

  if (has('enqueue')) {
    const programId = arg('program');
    if (!programId) throw new Error('PROGRAM_ID_REQUIRED');
    if (!has('confirm-enqueue')) throw new Error('CONFIRM_ENQUEUE_REQUIRED');
    if (!table) throw new Error('DELIVERY_TABLE_ABSENT');
    const program = await row('SELECT * FROM programs WHERE id=$1 AND state=$2', [programId, 'DRAFT']);
    if (!program) throw new Error('DRAFT_PROGRAM_NOT_FOUND');
    const {enqueueDraftForProgram} = await import('../../lib/standalone/vessel-draft-delivery-store.ts');
    const result = await enqueueDraftForProgram(program, config);
    console.log(JSON.stringify({
      step: 'enqueue',
      programId,
      status: result.status,
      reason: 'reason' in result ? result.reason : null,
      recipient: result.record ? mask(result.record.recipientJid) : null,
      deliveryId: result.record?.id ?? null,
      state: result.record?.state ?? null,
      sent: false,
    }, null, 2));
    return;
  }

  if (has('tick')) {
    if (!has('confirm-send')) throw new Error('CONFIRM_SEND_REQUIRED');
    if (!table) throw new Error('DELIVERY_TABLE_ABSENT');
    if (!gate.enabled) throw new Error(`DELIVERY_GATE_DISABLED:${gate.reasons.join(',')}`);
    const {runVesselDraftDeliveryTick} = await import('../../lib/vessel-draft-delivery-worker.ts');
    const limit = Math.min(Math.max(Number(arg('limit', '1')) || 1, 1), 10);
    const result = await runVesselDraftDeliveryTick({limit, gate: {config, gate}});
    console.log(JSON.stringify({step: 'tick', ...result, identities: 'masked'}, null, 2));
  }

  // Touch the status helper so an operator can see the same Admin projection
  // the workspace uses; it is read-only and degrades when the table is absent.
  if (has('status')) {
    const ids = programs.map((program) => program.id);
    console.log(JSON.stringify({step: 'status', rows: await deliveryStatusForPrograms(ids)}, null, 2));
  }
}

main().catch((error) => {
  console.error(JSON.stringify({
    status: 'FAILED',
    code: error?.message ?? 'VESSEL_DRAFT_ACTIVATION_FAILED',
  }));
  process.exitCode = 1;
});
