'use client';

import {useRouter} from 'next/navigation';
import {useState} from 'react';
import {buildActionFormRequest, type ActionFormMethod, type ActionFormRequestInput} from '@/lib/action-form-request';

export type Field = {
  name: string;
  label: string;
  type?: 'text' | 'number' | 'date' | 'select' | 'textarea' | 'hidden' | 'password';
  placeholder?: string;
  required?: boolean;
  options?: Array<{value: string; label: string}>;
  defaultValue?: string;
  /** Password field: render a second "confirm" input and require both to match. */
  confirm?: boolean;
  /** Compare this field against another field by name before submitting. */
  confirmWith?: string;
  /** Optional HTML minLength for the input. */
  minLength?: number;
};

type Props = {
  title?: string;
  endpoint: string;
  action?: string;
  /** Defaults to POST. Use PATCH/DELETE for routes that require them. */
  method?: ActionFormMethod;
  fields: Field[];
  submitLabel: string;
  hidden?: Record<string, string>;
  compact?: boolean;
  /** Navigate here after a successful submit instead of refreshing in place. */
  redirectTo?: string;
};

/**
 * Minimal, real form: posts JSON to an authenticated API with the session CSRF
 * token, surfaces the API error, and refreshes server data on success.
 */
export function ActionForm({title, endpoint, action, method, fields, submitLabel, hidden = {}, compact, redirectTo}: Props) {
  const router = useRouter();
  const [state, setState] = useState<{busy: boolean; error?: string; ok?: string}>({busy: false});

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    // Confirm-password fields must match before any request is made.
    for (const field of fields) {
      if (field.confirm) {
        const primary = (form.elements.namedItem(field.name) as HTMLInputElement | null)?.value ?? '';
        const confirmation = (form.elements.namedItem(`${field.name}Confirm`) as HTMLInputElement | null)?.value ?? '';
        if (primary !== confirmation) {
          setState({busy: false, error: 'পাসওয়ার্ড দুটি মিলছে না — আবার লিখুন। / Passwords do not match.'});
          return;
        }
      }
      if (field.confirmWith) {
        const value = (form.elements.namedItem(field.name) as HTMLInputElement | null)?.value ?? '';
        const other = (form.elements.namedItem(field.confirmWith) as HTMLInputElement | null)?.value ?? '';
        if (value !== other) {
          setState({busy: false, error: 'পাসওয়ার্ড দুটি মিলছে না — আবার লিখুন। / Passwords do not match.'});
          return;
        }
      }
    }
    const values: Record<string, unknown> = {...hidden};
    for (const field of fields) {
      const input = form.elements.namedItem(field.name) as HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement | null;
      if (!input) continue;
      let value: unknown = input.value;
      if (field.type === 'number') value = value === '' ? undefined : Number(value);
      if (value === '' || value === undefined) continue;
      values[field.name] = value;
    }
    setState({busy: true});
    try {
      const session = await fetch('/api/auth/session', {credentials: 'same-origin', cache: 'no-store'});
      if (!session.ok) throw new Error('SESSION_EXPIRED');
      const {csrf} = (await session.json()) as {csrf: string};
      const request: ActionFormRequestInput = {action, method, values, csrf};
      const init = buildActionFormRequest(request);
      const response = await fetch(endpoint, {
        method: init.method,
        credentials: 'same-origin',
        headers: init.headers,
        body: init.body,
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error ?? `HTTP_${response.status}`);
      form.reset();
      setState({busy: false, ok: 'Saved'});
      if (redirectTo) window.location.assign(redirectTo);
      else router.refresh();
    } catch (error) {
      setState({busy: false, error: error instanceof Error ? error.message : 'FAILED'});
    }
  }

  return (
    <form className={compact ? 'card form compact' : 'card form'} onSubmit={submit}>
      {title ? <h3>{title}</h3> : null}
      <div className="grid">
        {fields.map((field) => (
          <label key={field.name}>
            <span>{field.label}</span>
            {field.type === 'select' ? (
              <select name={field.name} required={field.required} defaultValue={field.defaultValue}>
                {(field.options ?? []).map((option) => (
                  <option key={option.value} value={option.value}>{option.label}</option>
                ))}
              </select>
            ) : field.type === 'textarea' ? (
              <textarea name={field.name} required={field.required} placeholder={field.placeholder} defaultValue={field.defaultValue} />
            ) : (
              <input
                name={field.name}
                type={field.type ?? 'text'}
                required={field.required}
                minLength={field.minLength}
                placeholder={field.placeholder}
                defaultValue={field.defaultValue}
                autoComplete={field.type === 'password' ? 'new-password' : undefined}
              />
            )}
          </label>
        ))}
        {fields.filter((field) => field.confirm).map((field) => (
          <label key={`${field.name}-confirm`}>
            <span>{field.label} (confirm)</span>
            <input name={`${field.name}Confirm`} type="password" required autoComplete="new-password" />
          </label>
        ))}
      </div>
      <button type="submit" disabled={state.busy}>{state.busy ? 'Working…' : submitLabel}</button>
      {state.error ? <p className="error">{state.error}</p> : null}
      {state.ok ? <p className="ok">{state.ok}</p> : null}
    </form>
  );
}
