import {redirect} from 'next/navigation';
import {currentIdentity} from '@/lib/unified-auth';
import {MIN_PASSWORD_LENGTH} from '@/lib/password-policy';
import {ActionForm} from '@/components/standalone/action-form';

export const dynamic = 'force-dynamic';

/**
 * Forced password change. Reached only while `must_change_password=true`:
 * the proxy sends every page request here, and the session identifies the user
 * (no username field). A successful change clears the flag in the database and
 * redirects to a fixed /home — never back to the login page.
 */
export default async function ChangePasswordPage() {
  const identity = await currentIdentity();
  if (!identity) redirect('/login');
  if (!identity.mustChangePassword) redirect('/home');
  return (
    <main className="login-wrap">
      <section className="login-card">
        <p className="brand">AL-RIFA’I · Business Management</p>
        <h1 style={{marginTop: 8}}>Choose a new password</h1>
        <p className="muted" style={{marginTop: -4, marginBottom: 18}}>
          Your password was changed by an admin. Set your own password to continue.
        </p>
        <ActionForm
          endpoint="/api/auth/password"
          submitLabel="Change password"
          redirectTo="/home"
          fields={[
            {
              name: 'newPassword',
              label: `New password (min ${MIN_PASSWORD_LENGTH})`,
              type: 'password',
              required: true,
              minLength: MIN_PASSWORD_LENGTH,
            },
            {
              name: 'confirmPassword',
              label: 'Confirm password',
              type: 'password',
              required: true,
              minLength: MIN_PASSWORD_LENGTH,
              confirmWith: 'newPassword',
            },
          ]}
        />
      </section>
    </main>
  );
}
