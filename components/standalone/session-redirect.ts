'use client';

/**
 * A 401 from the API means the session is gone (idle expiry, revoked, or a
 * missing cookie). Send the operator to the sign-in page instead of showing a
 * dead-end error, and keep the current page as the return target.
 */
export function isAuthenticationFailure(status: number, body: unknown): boolean {
  const code = (body as {error?: string} | null)?.error;
  return status === 401 || code === 'AUTHENTICATION_REQUIRED';
}

export function redirectToLogin(): void {
  if (typeof window === 'undefined') return;
  const next = `${window.location.pathname}${window.location.search}`;
  window.location.replace(`/login?reason=session_expired&next=${encodeURIComponent(next)}`);
}
