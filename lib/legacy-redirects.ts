// Browser-facing legacy routes with a verified Phase 3 equivalent.
// API routes and state-changing endpoints are deliberately not redirected.
export const LEGACY_REDIRECTS = [
  {source: '/transactions', destination: '/cash', permanent: false},
  {source: '/cash/archive', destination: '/cash', permanent: false},
  {source: '/cash/submissions', destination: '/cash', permanent: false},
  {source: '/register', destination: '/vessel', permanent: false},
  {source: '/vessel-register', destination: '/vessel', permanent: false},
  {source: '/sources-review', destination: '/review', permanent: false},
  {source: '/insights', destination: '/reports', permanent: false},
  {source: '/income-expenditure', destination: '/cash', permanent: false},
  {source: '/archive', destination: '/reports', permanent: false},
] as const;

export const LEGACY_UNMAPPED = ['/assistant'] as const;
