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
  /** JS-only required field: no HTML validation, shows an inline error. */
  softRequired?: boolean;
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
  /** Render the error banner above the submit button. */
  errorFirst?: boolean;
  /** Navigate here after a successful submit instead of refreshing in place. */
  redirectTo?: string;
};

const ERROR_LABELS: Record<string, string> = {
  INVALID_MOTHERVESSEL: 'Mother Vessel is required',
  MISSING_REQUIRED_FIELDS: 'Mother Vessel is required. Use Correct to fill in vessel fields, then Approve.',
  RELEASE_NOT_APPROVABLE: 'This is an escort release slip. Manual program matching will be available in v3.3.5. Please Decline for now.',
  CONFIRMATION_NOT_APPROVABLE: 'This is an escort assignment/confirmation message. Manual program matching and escort assign flow will be available in v3.3.5.',
  CASH_MESSAGE_MISROUTED: 'This is a cash instruction from Bridge-1 to Accountant, not a vessel order. Please Decline.',
};

/**
 * Minimal, real form: posts JSON to an authenticated API with the session CSRF
 * token, surfaces the API error, and refreshes server data on success.
 */
export function ActionForm({title, endpoint, action, method, fields, submitLabel, hidden = {}, compact, errorFirst, redirectTo}: Props) {
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
    for (const field of fields) {
      if (!field.softRequired) continue;
      const value = values[field.name];
      if (typeof value !== 'string' || !value.trim()) {
        setState({busy: false, error: `${field.label || field.name} is required`});
        return;
      }
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
      const body = await response.json().catch(() => ({})) as {error?: string; detail?: string};
      if (!response.ok) {
        const code = body.error ?? '';
        throw new Error(body.detail ?? ERROR_LABELS[code] ?? code ?? `HTTP_${response.status}`);
      }
      form.reset();
      setState({busy: false, ok: 'Saved'});
      if (redirectTo) window.location.assign(redirectTo);
      else router.refresh();
    } catch (error) {
      setState({busy: false, error: error instanceof Error ? error.message : 'FAILED'});
    }
  }

  return (
    <form
      className={compact ? 'card form compact' : 'card form'}
      onSubmit={submit}
      onInput={() => { if (state.error) setState({busy: false}); }}
    >
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
      {errorFirst && state.error ? (
        <p className="error" style={{
          margin: '0 0 8px', padding: '8px 10px', borderRadius: 6,
          background: '#fef2f2', border: '1px solid #fecaca', color: '#991b1b',
        }}>{state.error}</p>
      ) : null}
      <button type="submit" disabled={state.busy}>{state.busy ? 'Working…' : submitLabel}</button>
      {!errorFirst && state.error ? <p className="error">{state.error}</p> : null}
      {state.ok ? <p className="ok">{state.ok}</p> : null}
    </form>
  );
}
