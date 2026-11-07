# AL-RIFA'I Phase 3 — Production URLs and Compatibility

**Verified:** 2026-11-07, from outside the origin (public HTTPS).
**Canonical hostname:** `https://app.al-rifai.iamazim.com`
**Runtime image:** `local/al-rifai-platform:phase3-ai-rc-86d659a`
**Digest:** `sha256:932ef85621a0f99c2b15b1eaa615bad6e2dc87320f149787092c7c0f5a4079a5`

---

## 1. Public hostnames

| Hostname | DNS | Public result | TLS | Status |
|---|---|---|---|---|
| `app.al-rifai.iamazim.com` | A `5.189.131.48` | 307 → `/dashboard`; `/login` 200 | valid; SAN app + alrifai | **CANONICAL — VERIFIED** |
| `alrifai.iamazim.com` | A `5.189.131.48` | 307 → `/dashboard`; `/login` 200 | valid; SAN app + alrifai | **LEGACY ALIAS — VERIFIED** |
| `al-rifai.iamazim.com` | CNAME `custom-domains.chatgpt.site` → Cloudflare 104.18.x | **Cloudflare 1014** | Cloudflare edge | **BROKEN — DNS REPAIR REQUIRED** |

The origin is this VPS at `5.189.131.48`. The Phase 3 container publishes
`0.0.0.0:443` and `127.0.0.1:3001`.

### Error 1014 root cause

`al-rifai.iamazim.com` is a CNAME to `custom-domains.chatgpt.site`, a hostname
managed by a different Cloudflare account. Cloudflare rejects cross-account
CNAME targets with **1014 CNAME Cross-User Banned**. The application is not the
cause; the DNS target is.

The canonical and legacy hosts both have A records to the origin and work.

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
| `/vessel/[id]` | Program detail/lifecycle | auth required |
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

Prepared in `lib/legacy-redirects.ts` / `next.config.ts`; **not yet deployed**
to the running image. Deployment requires approval.

| Legacy route | Original meaning | Compatibility | Status |
|---|---|---|---|
| `/transactions` | Transactions ledger | 307 → `/cash` | PREPARED |
| `/cash/archive` | Cash archive | 307 → `/cash` | PREPARED |
| `/cash/submissions` | Cash submissions | 307 → `/cash` | PREPARED |
| `/register` | Vessel dashboard | 307 → `/vessel` | PREPARED |
| `/vessel-register` | Vessel Register | 307 → `/vessel` | PREPARED |
| `/sources-review` | Review queue | 307 → `/review` | PREPARED |
| `/insights` | Operational insights | 307 → `/reports` | PREPARED |
| `/income-expenditure` | Income/expenditure view | 307 → `/cash` | PREPARED |
| `/archive` | Archive | 307 → `/reports` | PREPARED |
| `/assistant` | AI Assistant | new `/assistant` Admin query page | PREPARED |
| `/conversations` | Legacy conversations | no Phase 3 page; `/messages` is the source-message equivalent | LEGACY ONLY |
| `/message-mirror` | Legacy mirror | no Phase 3 page | LEGACY ONLY |
| `/submissions` | Legacy submissions | `/cash` submissions section | LEGACY ONLY / cash equivalent |
| `/platform/*`, `/signup`, `/public-site` | legacy platform surfaces | no Phase 3 page | LEGACY ONLY |

No API endpoint is redirected. No state-changing route is redirected.

---

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
