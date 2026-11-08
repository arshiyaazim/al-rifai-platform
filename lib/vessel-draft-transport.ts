// AL-RIFA'I — narrow WA-01 Vessel Draft transport adapter.
//
// This module performs exactly one `send_message` bridge call for a prepared
// request. It is only reachable after the five-block delivery gate in
// lib/vessel-draft-delivery.ts and the worker's own env switch. It never
// chooses a recipient, never widens account scope and never retries by itself.
//
// A bridge timeout or transport failure is DELIVERY_UNKNOWN: the bridge may
// already have accepted the message, so it must not be resent automatically.

import {existsSync} from 'node:fs';
import {callSocketTool} from './standalone/whatsapp.ts';
import type {OutboundRequest} from './vessel-draft-delivery.ts';

export type VesselDraftTransportOutcome =
  | {kind: 'sent'; deliveryRef: string | null}
  | {kind: 'failed'; error: string}
  | {kind: 'unknown'; error: string};

export type VesselDraftTransportPaths = {
  socketPath: string;
  tokenFile: string;
};

export type VesselDraftSend = (
  request: OutboundRequest,
  paths: VesselDraftTransportPaths,
  callTool?: typeof callSocketTool,
) => Promise<VesselDraftTransportOutcome>;

/** Resolve the configured transport paths without exposing the token value. */
export function vesselDraftTransportPaths(): VesselDraftTransportPaths | null {
  const socketPath = process.env.ALRIFAI_VESSEL_DRAFT_SENDER_SOCKET?.trim();
  const tokenFile = process.env.ALRIFAI_VESSEL_DRAFT_SENDER_TOKEN_FILE?.trim();
  if (!socketPath || !tokenFile) return null;
  if (!existsSync(socketPath) || !existsSync(tokenFile)) return null;
  return {socketPath, tokenFile};
}

/**
 * One bridge send. The tool contract follows the existing WA-02 sender:
 * `send_message` with `{recipient, message}`. A `success:true` response is
 * bridge acceptance, not proof of recipient delivery/read.
 */
export const sendVesselDraft: VesselDraftSend = async (request, paths, callTool = callSocketTool) => {
  try {
    const result = await callTool(paths.socketPath, paths.tokenFile, 'send_message', {
      recipient: request.recipientJid,
      message: request.text,
    });
    if (result.success === true) {
      const ref = typeof result.messageId === 'string'
        ? result.messageId.slice(0, 200)
        : typeof result.id === 'string'
          ? result.id.slice(0, 200)
          : null;
      return {kind: 'sent', deliveryRef: ref};
    }
    const error = typeof result.message === 'string'
      ? result.message.slice(0, 300)
      : 'BRIDGE_REJECTED';
    return {kind: 'failed', error};
  } catch (error) {
    const code = error instanceof Error ? error.message : 'BRIDGE_UNKNOWN_ERROR';
    return {kind: 'unknown', error: code.slice(0, 300)};
  }
};