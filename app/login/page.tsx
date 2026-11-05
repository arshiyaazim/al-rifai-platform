import {LoginForm} from './login-form';

export const dynamic = 'force-dynamic';

export default function LoginPage() {
  return (
    <main className="login-wrap">
      <section className="login-card">
        <p className="brand">AL-RIFA’I · Business Management</p>
        <h1 style={{marginTop: 8}}>Sign in</h1>
        <p className="muted" style={{marginTop: -4, marginBottom: 18}}>
          Use the administrator account created during installation.
        </p>
        <LoginForm />
      </section>
    </main>
  );
}
