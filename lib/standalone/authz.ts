import {DomainError, type Actor} from './db.ts';
import {resolveCapabilities, type Capability} from '../unified-auth-policy.ts';

type CapabilityActor = Pick<Actor, 'role'> & {capabilities?: unknown};

/** Resolved capabilities for an API/service actor (role defaults + grants). */
export function capabilitiesFor(actor: CapabilityActor): Capability[] {
  return resolveCapabilities(actor.role, actor.capabilities);
}

export function can(actor: CapabilityActor, capability: Capability): boolean {
  return capabilitiesFor(actor).includes(capability);
}

/**
 * Defence in depth: routes check capabilities before calling a service, and
 * services that move or conclude money check again. A missing capability is a
 * 403 with a stable machine code; the UI only projects the same decision.
 */
export function assertCapability(actor: CapabilityActor, capability: Capability): void {
  if (!can(actor, capability)) throw new DomainError('CAPABILITY_REQUIRED', 403, capability);
}
