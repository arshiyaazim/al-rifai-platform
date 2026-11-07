'use client';

import {useState} from 'react';
import {sanitizeReturnTo} from '@/lib/unified-auth-policy';

export function LoginForm() {
  const [state, setState] = useState<{busy: boolean; error?: string}>({busy: false});
  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setState({busy: true});
    try {
      const response = await fetch('/api/auth/login', {
        method: 'POST',
        credentials: 'same-origin',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({username: form.get('username'), password: form.get('password')}),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error ?? `HTTP_${response.status}`);
      const next = new URLSearchParams(window.location.search).get('next');
      window.location.assign(sanitizeReturnTo(next));
    } catch (error) {
      setState({busy: false, error: error instanceof Error ? error.message : 'LOGIN_FAILED'});
    }
  }
  return (
    <form className="form" onSubmit={submit}>
      <label><span>Username</span><input name="username" autoComplete="username" required autoFocus /></label>
      <label style={{marginTop: 10}}><span>Password</span><input name="password" type="password" autoComplete="current-password" required /></label>
      <button type="submit" disabled={state.busy} style={{marginTop: 16, width: '100%'}}>
        {state.busy ? 'Signing in…' : 'Sign in'}
      </button>
      {state.error ? <p className="error">{state.error}</p> : null}
    </form>
  );
}
