import {redirect} from 'next/navigation';
import {requireIdentity} from '../unified-auth.ts';

export type PageUser = {
  id: string;
  username: string;
  role: 'ADMIN' | 'USER';
  displayName: string;
  mustChangePassword: boolean;
  capabilities: string[];
  superAdmin: boolean;
};

/** Server-side identity for pages. Unauthenticated visitors go to /login. */
export async function pageUser(): Promise<PageUser> {
  try {
    const identity = await requireIdentity();
    return {
      id: identity.id,
      username: identity.username,
      role: identity.role,
      displayName: identity.displayName,
      mustChangePassword: identity.mustChangePassword,
      capabilities: identity.capabilities,
      superAdmin: identity.superAdmin,
    };
  } catch {
    redirect('/login');
  }
}

export const money = (minor: string | number | null | undefined) =>
  minor === null || minor === undefined ? '—' : `৳${(Number(minor) / 100).toLocaleString('en-US', {minimumFractionDigits: 2})}`;

export const when = (value: string | Date | null | undefined) =>
  value ? new Date(value).toISOString().slice(0, 16).replace('T', ' ') : '—';
