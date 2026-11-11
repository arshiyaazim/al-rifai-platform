'use client';

import {useRouter} from 'next/navigation';
import {useState} from 'react';
import {buildActionFormRequest, type ActionFormMethod, type ActionFormRequestInput} from '@/lib/action-form-request';

export type Field = {
  name: string;
  label: string;
  type?: 'text' | 'number' | 'date' | 'select' | 'textarea' | 'hidden';
  placeholder?: string;
  required?: boolean;
  options?: Array<{value: string; label: string}>;
  defaultValue?: string;
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
};

/**
 * Minimal, real form: posts JSON to an authenticated API with the session CSRF
 * token, surfaces the API error, and refreshes server data on success.
 */
export function ActionForm({title, endpoint, action, method, fields, submitLabel, hidden = {}, compact}: Props) {
  const router = useRouter();
  const [state, setState] = useState<{busy: boolean; error?: string; ok?: string}>({busy: false});

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
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
      router.refresh();
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
                placeholder={field.placeholder}
                defaultValue={field.defaultValue}
              />
            )}
          </label>
        ))}
      </div>
      <button type="submit" disabled={state.busy}>{state.busy ? 'Working…' : submitLabel}</button>
      {state.error ? <p className="error">{state.error}</p> : null}
      {state.ok ? <p className="ok">{state.ok}</p> : null}
    </form>
  );
}
