/**
 * URL registry — the single place where the Assistant turns a page name plus
 * filters into a real URL.
 *
 * Every param here was verified against the page's own `searchParams`:
 *   /cash                  → q|search, state, employee_mobile, employeeName,
 *                            employeeMobile, payoutMobile, openPayment
 *   /cash/transactions     → q, from, to, employee_mobile, source, page
 *   /vessel                → q, state, mother, escort_mobile, page
 *   /attendance            → from, to, q, employee_mobile (client init)
 *   /employees             → q, state, designation (client init)
 *   /employees/[mobile]     and legacy /employee/[phone] profile pages.
 */

type ParamValue = string | number | boolean | undefined | null;

/** Drops empty values so Postgres never receives `''::date`-style input. */
function query(params: Record<string, ParamValue>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '' || value === false) continue;
    search.set(key, value === true ? '1' : String(value));
  }
  const encoded = search.toString();
  return encoded ? `?${encoded}` : '';
}

export const URL_REGISTRY = {
  employees: {
    base: '/employees',
    /** The page filters client-side; `q` is kept for deep links. */
    search: (q: string) => `/employees?q=${encodeURIComponent(q)}`,
    profile: (mobile: string) => `/employees/${encodeURIComponent(mobile)}`,
    legacyProfile: (phone: string) => `/employee/${encodeURIComponent(phone)}`,
  },
  cash: {
    base: '/cash',
    filter: (params: {
      q?: string; search?: string; state?: string; employee_mobile?: string;
      employeeName?: string; employeeMobile?: string; payoutMobile?: string; openPayment?: boolean;
    }) => `/cash${query(params)}`,
    employee: (mobile: string) => `/cash/employee/${encodeURIComponent(mobile)}`,
    transactions: {
      base: '/cash/transactions',
      filter: (params: {q?: string; from?: string; to?: string; employee_mobile?: string; source?: string; page?: number}) =>
        `/cash/transactions${query(params)}`,
    },
  },
  attendance: {
    base: '/attendance',
    filter: (params: {q?: string; from?: string; to?: string; employee_mobile?: string}) =>
      `/attendance${query(params)}`,
  },
  vessel: {
    base: '/vessel',
    filter: (params: {q?: string; state?: string; mother?: string; escort_mobile?: string; page?: number}) =>
      `/vessel${query(params)}`,
    detail: (id: string) => `/vessel/${encodeURIComponent(id)}`,
  },
  review: {
    base: '/review',
    filter: (params: {category?: string}) => `/review${query(params)}`,
  },
} as const;

const BASES: Record<string, string> = {
  employees: '/employees',
  'employees/profile': '/employees',
  cash: '/cash',
  'cash/transactions': '/cash/transactions',
  attendance: '/attendance',
  vessel: '/vessel',
  review: '/review',
};

/**
 * `buildUrl('vessel', {state: 'RUNNING', escort_mobile: '+8801…'})`
 * → `/vessel?state=RUNNING&escort_mobile=%2B8801…`
 */
export function buildUrl(page: string, filters: Record<string, ParamValue> = {}): string {
  const base = BASES[page];
  if (!base) throw new Error(`UNKNOWN_PAGE: ${page}`);
  if (page === 'employees/profile') {
    const mobile = filters.mobile;
    if (!mobile) throw new Error('EMPLOYEE_MOBILE_REQUIRED');
    return `${base}/${encodeURIComponent(String(mobile))}`;
  }
  return `${base}${query(filters)}`;
}

export type UrlRegistry = typeof URL_REGISTRY;
