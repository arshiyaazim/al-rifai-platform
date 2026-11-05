// Vessel command authorization policy (pure). No database, no client-supplied
// actor identity: the actor is resolved server-side from configuration.

import type {ChatGPTUser} from '@/app/chatgpt-auth';

export type CommandActor = {ref: string};
export type VesselCommandUser = Pick<ChatGPTUser,'userId'> & Partial<Pick<ChatGPTUser,'role'|'capabilities'>>;
export type VesselReadUser = Pick<ChatGPTUser,'userId'|'role'|'capabilities'>;

export class VesselCommandError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, status = 403) {
    super(code);
    this.name = 'VesselCommandError';
    this.code = code;
    this.status = status;
  }
}

/** General users and admins may read Vessel details only with the read capability. */
export function canReadVessel(user: VesselReadUser | null | undefined): boolean {
  if (!user) return false;
  if (user.userId === 'local-validator') return true;
  return (user.role === 'ADMIN' || user.role === 'USER')
    && (user.capabilities ?? []).includes('vessel.read');
}

export function assertCanReadVessel(user: VesselReadUser | null | undefined): void {
  if (!user) throw new VesselCommandError('AUTHENTICATION_REQUIRED', 401);
  if (!canReadVessel(user)) throw new VesselCommandError('VESSEL_READ_FORBIDDEN', 403);
}

/**
 * Application-level role gate. Two identities may command:
 *
 *  * the legacy validation credential (the Owner signing in with Basic), and
 *  * a unified session whose stored role is ADMIN and whose resolved capabilities
 *    include vessel.command.
 *
 * The second arm is not a widening for convenience: RBAC-2 made ADMIN the role that
 * writes directly (vessel.command) while USER stages through review (vessel.submit).
 * Before this, an ADMIN signed in with the unified session was refused with
 * VESSEL_COMMAND_FORBIDDEN — the button worked, the API did not.
 */
export function canCommandVessel(user: VesselCommandUser | null | undefined): boolean {
  if (!user) return false;
  if (user.userId === 'local-validator') return true;
  return user.role === 'ADMIN' && (user.capabilities ?? []).includes('vessel.command');
}

export function assertCanCommandVessel(user: VesselCommandUser | null | undefined): void {
  if (!user) throw new VesselCommandError('AUTHENTICATION_REQUIRED', 401);
  if (!canCommandVessel(user)) throw new VesselCommandError('VESSEL_COMMAND_FORBIDDEN', 403);
}

/**
 * Server-owned actor identity. Never accepted from the request body.
 * Falls back to the configured Cash Owner person reference (the same verified
 * Owner identity used by Cash), so no new secret or client input is needed.
 */
export function commandActorFromEnv(env: Record<string, string | undefined>): CommandActor {
  const ref = (env.ALRIFAI_VESSEL_COMMAND_ACTOR || env.ALRIFAI_CASH_OWNER_PERSON_REF || '').trim();
  if (!ref) throw new VesselCommandError('VESSEL_COMMAND_ACTOR_NOT_CONFIGURED', 503);
  return {ref};
}

export const MIGRATION_DEPENDENCY = 'MIGRATION_0032_VESSEL_PROGRAM_COMMANDS_NOT_APPLIED';

/** Maps PostgreSQL outcomes to HTTP-safe errors without leaking SQL details. */
export function mapCommandError(error: unknown): VesselCommandError {
  const code = (error as {code?: string})?.code;
  if (code === '42P01' || code === '42883' || code === '3F000') {
    return new VesselCommandError(MIGRATION_DEPENDENCY, 503);
  }
  if (code === '42501') return new VesselCommandError('VESSEL_COMMAND_FORBIDDEN', 403);
  const message = error instanceof Error ? error.message : '';
  // Phase 3: create_employee_if_new rejects an unusable mobile (and an unknown duty
  // type) with a prefixed message, e.g. INVALID_MOBILE:12345. Those are caller errors,
  // not server faults, so they must map to 400 rather than the 500 fallback.
  const invalid = /^(INVALID_MOBILE|INVALID_DUTY_TYPE)(?::|$)/.exec(message);
  if (invalid) {
    return new VesselCommandError(invalid[1] === 'INVALID_MOBILE' ? 'MOBILE_INVALID' : 'DUTY_TYPE_INVALID', 400);
  }
  const known = /^(VERIFIED_ACTOR_REQUIRED|REVISION_CONFLICT|PROGRAM_NOT_FOUND|PROGRAM_ALREADY_VOIDED|ASSIGNMENT_EXISTS_USE_REPLACE|COMMAND_KEY_REQUIRED|FIELD_NOT_EDITABLE|PATCH_REQUIRED|RELEASE_FIELDS_REQUIRED|EMPLOYEE_MOBILE_INVALID|SHIFT_REQUIRED|VOID_REASON_REQUIRED|VESSEL_PAIR_REQUIRED|PROGRAM_ID_REQUIRED|SHIFT_INVALID)$/.exec(message);
  if (known) {
    const status = message === 'PROGRAM_NOT_FOUND' ? 404
      : message === 'REVISION_CONFLICT' || message === 'PROGRAM_ALREADY_VOIDED' || message === 'ASSIGNMENT_EXISTS_USE_REPLACE' ? 409
        : 400;
    return new VesselCommandError(message, status);
  }
  return new VesselCommandError('VESSEL_COMMAND_FAILED', 500);
}
