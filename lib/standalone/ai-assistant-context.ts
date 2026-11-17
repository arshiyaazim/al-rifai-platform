/**
 * Conversation-context tokens (E2.6). The client stores one opaque string and
 * sends it back; the server can therefore inherit the last domain (and its
 * date range / employee) for follow-ups like "নেয়াজের?" after "গতকালের ক্যাশ".
 * Tokens expire after 10 minutes. Old flow ids remain valid tokens.
 */
import {FLOW_IDS, type FlowId} from './ai-assistant-walkthrough.ts';

export type ContextDomain = 'cash' | 'attendance' | 'vessel' | 'employee' | 'flow';

export type AssistantContext = {
  domain: ContextDomain;
  employeeMobile?: string;
  from?: string;
  to?: string;
  flow?: FlowId;
  at: number;
};

export const CONTEXT_TTL_MS = 10 * 60 * 1000;

const DOMAINS: ContextDomain[] = ['cash', 'attendance', 'vessel', 'employee', 'flow'];
const enc = (value: string | undefined) => encodeURIComponent(value ?? '');
const dec = (value: string) => decodeURIComponent(value);

export function encodeContext(context: Omit<AssistantContext, 'at'> & {at?: number}): string {
  return [
    'v1', context.domain, enc(context.employeeMobile), enc(context.from), enc(context.to),
    String(context.at ?? Date.now()), enc(context.flow),
  ].join('|');
}

export function decodeContext(token: unknown, now: Date = new Date(), ttlMs = CONTEXT_TTL_MS): AssistantContext | null {
  if (!token) return null;
  const raw = String(token).trim();
  if (!raw) return null;
  if ((FLOW_IDS as string[]).includes(raw)) {
    return {domain: 'flow', flow: raw as FlowId, at: now.getTime()};
  }
  const parts = raw.split('|');
  if (parts.length !== 7 || parts[0] !== 'v1') return null;
  const domain = parts[1] as ContextDomain;
  if (!DOMAINS.includes(domain)) return null;
  const at = Number(parts[5]);
  if (!Number.isFinite(at) || now.getTime() - at > ttlMs || at - now.getTime() > 60_000) return null;
  const context: AssistantContext = {
    domain, at,
    employeeMobile: dec(parts[2]) || undefined,
    from: dec(parts[3]) || undefined,
    to: dec(parts[4]) || undefined,
    flow: (dec(parts[6]) as FlowId) || undefined,
  };
  return context;
}
