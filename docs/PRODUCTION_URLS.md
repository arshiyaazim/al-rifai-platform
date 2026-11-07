# AL-RIFA'I Phase 3 — Production URLs and Compatibility

**Verified:** 2026-11-07, from outside the origin (public HTTPS).
**Canonical hostname:** `https://app.al-rifai.iamazim.com`
**Runtime image (production):** `local/al-rifai-platform:phase3-ai-rc-86d659a`
**Runtime digest:** `sha256:932ef85621a0f99c2b15b1eaa615bad6e2dc87320f149787092c7c0f5a4079a5`
**Candidate (built, tested, NOT deployed):** `local/al-rifai-platform:phase3-ai-rc-9e85e49`
**Candidate digest:** `sha256:cb8de252663fc04462eacf23a8eb1bbd39fe3af6a2a81230cdf3fa43a26075a0`

---

## 1. Public hostnames

| Hostname | DNS | Public result | TLS | Status |
|---|---|---|---|---|
| `app.al-rifai.iamazim.com` | A `5.189.131.48` | 307 → `/dashboard`; `/login` 200 | valid; SAN app + alrifai | **CANONICAL — VERIFIED** |
| `alrifai.iamazim.com` | A `5.189.131.48` | 307 → `/dashboard`; `/login` 200; login API accepts origin | valid; SAN app + alrifai | **LEGACY ALIAS — VERIFIED** |
| `al-rifai.iamazim.com` | CNAME `custom-domains.chatgpt.site` → Cloudflare 104.18.x | **Cloudflare 1014** | Cloudflare edge | **BROKEN — DNS REPAIR REQUIRED** |

The origin is this VPS at `5.189.131.48`. The Phase 3 container publishes
`0.0.0.0:443` and `127.0.0.1:3001`.

### Error 1014 root cause

`al-rifai.iamazim.com` is a CNAME to `custom-domains.chatgpt.site`, a hostname
managed by a different Cloudflare account. Cloudflare rejects cross-account
CNAME targets with **1014 CNAME Cross-User Banned**. The application is not the
cause; the DNS target is.

The canonical and legacy hosts both have A records to the origin and work. Both exact hosts are in `ALRIFAI_UNIFIED_ORIGINS`, so login from either reaches credential verification.

---

## 2. Implemented Phase 3 routes

Protected browser routes require a valid session; unauthenticated requests are
redirected to `/login` or receive 401 depending on the request type.

| Route | Purpose | Current |
|---|---|---|
| `/login` | Sign-in | 200 |
| `/dashboard` | Dashboard | auth required |
| `/cash` | Cash instructions, review, ledger, submissions | auth required |
| `/cash/[id]` | Instruction detail | auth required |
| `/vessel` | Vessel Register | auth required |
| `/vessel/drafts` | Vessel Order Drafts — exact Owner draft, copy-only (candidate `9e85e49`) | auth required |
| `/vessel/[id]` | Program detail/lifecycle, includes the Owner draft block | auth required |
| `/employees` | Employee directory | auth required |
| `/employees/[mobile]` | Employee profile | auth required |
| `/attendance` | Attendance and corrections | auth required |
| `/payroll` | Payroll/rates | auth required |
| `/reports` | CSV exports and audit | auth required |
| `/review` | Review queue | auth required |
| `/review/[id]` | Review item | auth required |
| `/messages` | WhatsApp source messages | auth required |
| `/settings` | Settings/accounts/users | auth required |
| `/assistant` | Admin AI query page (new in pending release) | auth required |
| `/api/health` | Health | 200, public |

`/assistant` calls the existing `/api/assistant` query API with scoped tools.
It does not enable outbound messaging or automatic replies.

---

## 3. Legacy browser routes and compatibility

Distinct legacy menu routes are now **independent Phase 3 pages**; no generic
redirects are used. They require authentication and preserve the browser URL.

| Legacy/current route | Phase 3 page | Status |
|---|---|---|
| `/transactions` | Cash instructions + ledger with filters/pagination | ACTIVE |
| `/cash/transactions` | Cash transactions view | ACTIVE |
| `/cash/archive` | Posted Cash instructions + immutable ledger | ACTIVE |
| `/cash/submissions` | Cash submissions/review candidates with decisions | ACTIVE |
| `/submissions` | My Submissions | ACTIVE |
| `/register` | Vessel order/register view | ACTIVE |
| `/vessel-register` | Vessel Register | ACTIVE |
| `/vessel/register` | Nested Vessel Register | ACTIVE |
| `/vessel/vessel-register` | Nested legacy Vessel Register | ACTIVE |
| `/sources-review` | Review queue + Cash candidates | ACTIVE |
| `/insights` | Operational metrics | ACTIVE |
| `/income-expenditure` | Posted-ledger income/expense report | ACTIVE |
| `/archive` | Audit trail + ledger archive | ACTIVE |
| `/conversations` | Chat list with message counts | ACTIVE |
| `/message-mirror` | Read-only message mirror with search | ACTIVE |
| `/assistant` | Admin AI query page | ACTIVE |
| `/employee` | Employee directory alias | ACTIVE |
| `/employee/[phone]` | Employee profile/payment history | ACTIVE |
| `/transactions/employee/[phone]` | Employee transaction history | ACTIVE |
| `/signup`, `/public-site`, `/platform/*` | no current Phase 3 business page | LEGACY ONLY — OWNER DECISION |

No API endpoint is redirected. No state-changing route is redirected.
## 4. Internal services

| Service | Address |
|---|---|
| App container | `al-rifai-phase3-app-1:3000` (TLS proxy `3443`) |
| Host app | `127.0.0.1:3001` |
| PostgreSQL | `vps-infra-postgres-1:5432`, database `alrifai_v2_phase3` |
| WA-01 bridge | `vps-whatsapp-wa-01-cap4-20261011`, private network |
| WA-02 bridge | `vps-whatsapp-wa-02-cap4-20261011`, private network |

---

## 5. Authentication entry points

- Browser login: `/login`
- Login API: `POST /api/auth/login`
- Session: `GET /api/auth/session`
- Logout: `POST /api/auth/logout`
- Password change: `POST /api/auth/password`

Admin provisioning and user provisioning are documented in
`docs/ADMIN_AUTH.md` and the README.
