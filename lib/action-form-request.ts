// Pure request builder shared by ActionForm. Kept separate from the React
// component so the HTTP wiring (especially PATCH vs POST) is unit-testable.
// No network call and no secret handling happens here.

export type ActionFormMethod = 'POST' | 'PATCH' | 'DELETE';

const METHODS: readonly ActionFormMethod[] = ['POST', 'PATCH', 'DELETE'];

export type ActionFormRequestInput = {
  action?: string;
  method?: ActionFormMethod;
  values: Record<string, unknown>;
  csrf: string;
};

export type ActionFormRequest = {
  method: ActionFormMethod;
  headers: Record<string, string>;
  body: string;
};

/**
 * Build the fetch init for an ActionForm submission. POST stays the default so
 * every existing form is unchanged; callers that target a PATCH/DELETE route
 * must state it explicitly.
 */
export function buildActionFormRequest(input: ActionFormRequestInput): ActionFormRequest {
  const method = input.method ?? 'POST';
  if (!METHODS.includes(method)) throw new Error(`ACTION_FORM_METHOD_INVALID:${method}`);
  if (!/^[a-f0-9]{64}$/.test(input.csrf)) throw new Error('ACTION_FORM_CSRF_INVALID');
  // The declared action is authoritative: a form field named "action" must not
  // be able to override the endpoint's intended action.
  const body = input.action
    ? {...input.values, action: input.action}
    : {...input.values};
  return {
    method,
    headers: {'Content-Type': 'application/json', 'X-CSRF-Token': input.csrf},
    body: JSON.stringify(body),
  };
}
