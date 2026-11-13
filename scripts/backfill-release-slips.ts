#!/usr/bin/env node
// AL-RIFA'I — Escort Release slip backfill / audit (DRY RUN).
//
// The release review page derives slips from the messages themselves, so there
// is no separate slip table to backfill. This script reports what the parser
// sees across the whole release group, what is already applied, and how the
// cash cross-check behaves — the evidence an operator needs before any bulk
// decision.
//
// Usage:
//   node --experimental-strip-types scripts/backfill-release-slips.ts
//   node --experimental-strip-types scripts/backfill-release-slips.ts --apply --structured-only
//
// `--apply` writes releases only when `--structured-only` is also passed:
// structured slips whose escort mobile, end date and a single matching program
// are all resolved. Payment-line slips are never applied in bulk. Without
// --apply nothing is written.

import {loadEnv} from '../lib/env.mjs';
import {rows, row, type Actor} from '../lib/standalone/db.ts';
import {releaseProgram} from '../lib/standalone/programs.ts';
import {compareVesselNames} from '../lib/vessel-match.ts';
import {parseReleaseSlips} from '../lib/release-slip.ts';
import {parseMessage} from '../lib/release-parser.ts';
import {listReleaseSlips, RELEASE_CHAT_JID} from '../lib/standalone/release-slips.ts';

loadEnv();

const APPLY = process.argv.includes('--apply');
const STRUCTURED_ONLY = process.argv.includes('--structured-only');
const actor: Actor = {id: 'system:release-backfill', role: 'ADMIN'};

const messages = await rows<{
  message_id: string; source_timestamp: string; text_content: string | null; media_type: string | null;
}>(
  `SELECT message_id, source_timestamp::text AS source_timestamp, text_content, media_type
     FROM whatsapp_messages
    WHERE chat_jid = $1 AND deleted_at IS NULL
    ORDER BY source_timestamp`,
  [RELEASE_CHAT_JID],
);

let empty = 0;
let structured = 0;
let paymentLine = 0;
let unparsed = 0;
const unparsedSamples: Array<{id: string; text: string}> = [];

for (const message of messages) {
  const text = String(message.text_content ?? '');
  if (!text.trim()) { empty += 1; continue; }
  if (parseReleaseSlips(text).length) { structured += 1; continue; }
  if (parseMessage(text, message.source_timestamp).length) { paymentLine += 1; continue; }
  unparsed += 1;
  if (unparsedSamples.length < 5) unparsedSamples.push({id: message.message_id, text: text.slice(0, 160)});
}

const slips = await listReleaseSlips();
const pending = slips.filter((slip) => slip.status === 'PENDING');
const approved = slips.filter((slip) => slip.status === 'APPROVED');
const declined = slips.filter((slip) => slip.status === 'DECLINED');
const verified = slips.filter((slip) => slip.cashVerified);
const missing = slips.filter((slip) => slip.escortMobile && slip.endDate && !slip.cashVerified);

console.log(JSON.stringify({
  mode: APPLY ? 'APPLY-REQUESTED' : 'DRY-RUN',
  chat: RELEASE_CHAT_JID,
  messagesScanned: messages.length,
  emptyOrMediaOnly: empty,
  structuredSlips: structured,
  paymentLineSlips: paymentLine,
  unparsed,
  unparsedSamples,
  derivedSlips: slips.length,
  alreadyApplied: approved.length,
  declined: declined.length,
  pending: pending.length,
  cash: {verified: verified.length, missing: missing.length},
  foodBillTotalMinor: slips.reduce((sum, slip) => sum + Number(slip.foodBillMinor ?? 0), 0),
}, null, 2));

// ---------------------------------------------------------------------------
// Apply (structured slips only)
// ---------------------------------------------------------------------------

type Candidate = {
  id: string;
  state: string;
  start_date: string;
  end_date: string | null;
  lighter_vessel: string | null;
  mother_vessel: string | null;
  release_message_id: string | null;
};

const sameVessel = (left: string | null | undefined, right: string | null | undefined) =>
  Boolean(left && right) && compareVesselNames(String(left), String(right)) !== 'DIFFERENT';

const results: Array<{messageId: string; outcome: string; detail: string}> = [];

if (APPLY && !STRUCTURED_ONLY) {
  console.log('\nRefusing: --apply requires --structured-only in this batch. Nothing was written.');
} else if (APPLY) {
  const structured = slips.filter((slip) => slip.structured);
  for (const slip of structured) {
    if (slip.status !== 'PENDING') {
      results.push({messageId: slip.messageId, outcome: 'SKIPPED', detail: `ALREADY_${slip.status}`});
      continue;
    }
    if (!slip.escortMobile || !slip.endDate) {
      results.push({messageId: slip.messageId, outcome: 'SKIPPED', detail: 'INCOMPLETE'});
      continue;
    }
    const candidates = await rows<Candidate>(
      `SELECT id, state, start_date::text AS start_date, end_date::text AS end_date,
              lighter_vessel, mother_vessel, release_message_id
         FROM programs
        WHERE escort_mobile = $1
          AND state IN ('CONFIRMED','ASSIGNED','IN_DUTY')
          AND start_date <= $2::date
        ORDER BY start_date DESC`,
      [`+88${slip.escortMobile}`, slip.endDate],
    );
    const byLighter = slip.lighterVessel
      ? candidates.filter((candidate) => sameVessel(candidate.lighter_vessel, slip.lighterVessel))
      : candidates;
    const byMother = slip.motherVessel
      ? byLighter.filter((candidate) => sameVessel(candidate.mother_vessel, slip.motherVessel))
      : byLighter;
    const matches = byMother.length ? byMother : byLighter;
    if (!matches.length) {
      results.push({messageId: slip.messageId, outcome: 'SKIPPED', detail: 'NO_MATCHING_PROGRAM'});
      continue;
    }
    if (matches.length > 1) {
      results.push({messageId: slip.messageId, outcome: 'SKIPPED', detail: `AMBIGUOUS(${matches.length})`});
      continue;
    }
    const program = matches[0];
    if (program.release_message_id === slip.messageId) {
      results.push({messageId: slip.messageId, outcome: 'SKIPPED', detail: 'ALREADY_APPLIED'});
      continue;
    }
    try {
      await releaseProgram(actor, program.id, {
        endDate: slip.endDate,
        endShift: slip.endShift ?? 'D',
        note: `Backfill release slip ${slip.messageId}`,
        release: {
          messageId: slip.messageId,
          chatJid: RELEASE_CHAT_JID,
          senderJid: null,
          accountId: 'wa-01',
          timestamp: slip.messageAt,
        },
      });
      results.push({messageId: slip.messageId, outcome: 'APPLIED', detail: program.id});
    } catch (error) {
      results.push({messageId: slip.messageId, outcome: 'SKIPPED', detail: `ERROR:${(error as Error).message.slice(0, 80)}`});
    }
  }
  console.log('\n--- structured apply results ---');
  for (const result of results) console.log(`${result.messageId} | ${result.outcome} | ${result.detail}`);
  console.log(JSON.stringify({
    structured: slips.filter((slip) => slip.structured).length,
    applied: results.filter((result) => result.outcome === 'APPLIED').length,
    skipped: results.filter((result) => result.outcome === 'SKIPPED').length,
  }, null, 2));
} else {
  console.log('\nDry run only. Nothing was written.');
}
