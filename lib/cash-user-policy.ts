// Cash Portal user-management authorization policy.
//
// Pure functions only — no database access, no sessions, no secrets. The route
// supplies the actor, the target row and the current count of active ADMINs.
// Rules:
//   * only a configured Super Admin may create ADMIN accounts;
//   * only a Super Admin may reset, demote, deactivate or edit an ADMIN target
//     (including the Super Admin account itself);
//   * the final active ADMIN account can never be demoted or deactivated;
//   * anything else an ADMIN does keeps working exactly as before.
//
// These guards complement — never replace — the existing session, CSRF and
// origin checks in lib/cash-portal.ts.

export type PolicyActor = {id: string; role: 'ADMIN' | 'USER'};
export type PolicyTarget = {id: string; role: 'ADMIN' | 'USER'; active: boolean};

export class CashUserPolicyError extends Error {
  readonly code: string;
  readonly status = 403;
  constructor(code: string) {
    super(code);
    this.name = 'CashUserPolicyError';
    this.code = code;
  }
}

const deny = (code: string): never => {
  throw new CashUserPolicyError(code);
};

/** True when the actor may perform Super-Admin-only actions. */
export const actorIsSuperAdmin = (isSuperAdmin: boolean) => isSuperAdmin === true;

export function assertCanCreateUser(
  actor: PolicyActor,
  requestedRole: 'ADMIN' | 'USER',
  superAdmin: boolean,
): void {
  if (actor.role !== 'ADMIN') deny('ADMIN_REQUIRED');
  if (requestedRole === 'ADMIN' && !actorIsSuperAdmin(superAdmin)) deny('SUPER_ADMIN_REQUIRED');
}

/**
 * Guard for resetting another user's password. A non-Super ADMIN may reset a
 * USER password (existing behaviour) but never an ADMIN/Super-Admin password.
 */
export function assertCanResetPassword(
  actor: PolicyActor,
  target: PolicyTarget,
  superAdmin: boolean,
): void {
  if (actor.role !== 'ADMIN') deny('ADMIN_REQUIRED');
  if (target.role === 'ADMIN' && !actorIsSuperAdmin(superAdmin)) deny('SUPER_ADMIN_REQUIRED');
}

export type ManageUserInput = {
  actor: PolicyActor;
  target: PolicyTarget;
  nextRole: 'ADMIN' | 'USER';
  nextActive: boolean;
  /** Active ADMIN accounts *including* the target, counted before the change. */
  activeAdmins: number;
  superAdmin: boolean;
};

/**
 * Guard for profile/role/active changes. USER targets remain editable by any
 * ADMIN. ADMIN targets require Super Admin. Removing the last active ADMIN is
 * always refused, even for the Super Admin.
 */
export function assertCanManageUser(input: ManageUserInput): void {
  const {actor, target, nextRole, nextActive, activeAdmins, superAdmin} = input;
  if (actor.role !== 'ADMIN') deny('ADMIN_REQUIRED');
  if (target.role === 'ADMIN' && !actorIsSuperAdmin(superAdmin)) deny('SUPER_ADMIN_REQUIRED');
  // Promoting an ordinary account to ADMIN is an ADMIN-creating action.
  if (target.role !== 'ADMIN' && nextRole === 'ADMIN' && !actorIsSuperAdmin(superAdmin)) deny('SUPER_ADMIN_REQUIRED');
  const removesAdmin = target.role === 'ADMIN' && target.active === true
    && (nextRole !== 'ADMIN' || nextActive === false);
  if (removesAdmin && activeAdmins <= 1) deny('LAST_ADMIN_PROTECTED');
}

/** Guard for creating the very first user or restoring an empty admin pool. */
export function assertAdminPoolRemains(activeAdmins: number): void {
  if (activeAdmins <= 0) deny('LAST_ADMIN_PROTECTED');
}

/** Stable, non-sensitive description used in the audit detail payload. */
export function describePolicyDecision(code: string): string {
  switch (code) {
    case 'SUPER_ADMIN_REQUIRED':
      return 'Only a configured Super Admin may manage ADMIN accounts.';
    case 'LAST_ADMIN_PROTECTED':
      return 'The final active administrative account cannot be removed.';
    case 'ADMIN_REQUIRED':
      return 'Administrative role required.';
    default:
      return 'User management denied by policy.';
  }
}
