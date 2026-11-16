import {LoginForm} from './login-form';

export const dynamic = 'force-dynamic';

export default async function LoginPage({searchParams}: {searchParams: Promise<{passwordChangeRequired?: string; reason?: string}>}) {
  const params = await searchParams;
  const passwordChangeRequired = params.passwordChangeRequired === '1';
  const sessionExpired = params.reason === 'session_expired';
  return (
    <main className="login-wrap">
      <section className="login-card">
        <p className="brand">AL-RIFA’I · Business Management</p>
        <h1 style={{marginTop: 8}}>Sign in</h1>
        <p className="muted" style={{marginTop: -4, marginBottom: 18}}>
          Use the administrator account created during installation.
        </p>
        {sessionExpired ? (
          <p
            role="status"
            style={{
              background: '#fef3c7',
              border: '1px solid #f59e0b',
              color: '#92400e',
              borderRadius: 8,
              padding: '10px 12px',
              fontSize: 13,
              marginBottom: 14,
            }}
          >
            Session expired — sign in again.
          </p>
        ) : null}
        {passwordChangeRequired ? (
          <p
            role="status"
            style={{
              background: '#eff6ff',
              border: '1px solid #bfdbfe',
              color: '#1e3a8a',
              borderRadius: 8,
              padding: '10px 12px',
              fontSize: 13,
              marginBottom: 14,
            }}
          >
            Your password was changed by an admin. Sign in, then choose a new password to continue.
          </p>
        ) : null}
        <LoginForm />
      </section>
    </main>
  );
}
