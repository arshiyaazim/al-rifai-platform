# Inactive identity, permissions and routing candidate

This implements the Owner-authorized **offline** first-release preparation inside
the existing AL-RIFA’I application. No active page, API route, proxy, package
command, consumer, configuration or production database imports this directory.
The existing corrected Escort module is reused without changing its bytes.

The consolidated contract, reuse matrix, qualification results and approval gates
are in [the reconciliation specification](../../docs/IDENTITY_PERMISSIONS_ROUTING_RECONCILIATION_SPEC.md).

## Cash development scope — Owner authorization, 25 October 2026

The previous Cash development freeze is superseded for the Owner-authorized
Cash, WhatsApp, Message Mirror, Vessel, and UI integration scope. This candidate
directory remains offline-only and unregistered; it must preserve identity,
authorization, PN/LID routing, review, and source-evidence safeguards. The
unfreeze does not authorize production migration, deployment, restart, Live
Sync, historical backfill, WA-02 permission expansion, or financial posting.
See the repository-root `AGENTS.md` and current recovery handoff.

## Entry points and dependencies

| File | Responsibility |
|---|---|
| `catalog.ts` / `contracts.ts` | Browser-safe domain catalog, strict server contracts, source-role phone normalization and hash identities |
| `auth.ts` | Named-account password hashing, opaque sessions, CSRF and expiry |
| `repository.ts` | Injected memory/disposable PostgreSQL repositories; no production connection factory |
| `routing.ts` | Verified identity/capabilities, group review, Escort adapter and conflict-preserving field merge |
| `service.ts` | Approved offline provisioning, registry history, evidence/review operations and audit |
| `api.ts` | Unregistered Request/Response API factory; trusted host supplies origin and peer address |
| `mcp-read.ts` | Bounded read-only client interface; actual account-scoped MCP client is unavailable |
| `ui/IdentityReviewPanel.tsx` | Unmounted React panel for named login, registry proposals and source-scoped review |
| `migrations/0001_identity_review_candidate.sql` | Disposable schema preview, outside the application migration runner |

Dependencies already exist: Node crypto/util, Zod, React and injected `pg` pool.
`routing.ts` imports `../../lib/escort-intake-candidate.mjs`, which imports the
unchanged pure validation helper. No Core Python package, provider, new service,
bridge store, live database pool or sending implementation is imported.

`evidence-baseline.json` pins approved policy/contracts, the original candidate and
tests, native fixtures and Core revision. Qualification fails if pinned bytes
change. Fixture paths must identify the private originals; there is no fallback
to invented business data. Native sender representations are retained, including
bare native PN digits. No JID suffix is manufactured.

## Reproduce offline qualification

Run from `/opt/vps/apps/al-rifai` with the retained Node 22.23.3 binary or an
equivalent qualified Node runtime. The commands below do not run the application.

```bash
export ALRIFAI_ESCORT_FIXTURES=/tmp/alrifai-four-fail-20261011/fixtures.json
export ALRIFAI_ESCORT_NATIVE_FIXTURES=/tmp/alrifai-escort-correction-20261011/native-fixtures.json
/tmp/alrifai-preparation-node --experimental-strip-types --test tests/identity-review-candidate.mjs
/tmp/alrifai-preparation-node --experimental-strip-types --test tests/identity-review-ui.mjs
python3 candidates/identity-review/qualify-postgres.py
/tmp/alrifai-preparation-node node_modules/typescript/bin/tsc --noEmit --incremental false
/tmp/alrifai-preparation-node node_modules/eslint/bin/eslint.js candidates/identity-review tests/identity-review-candidate.mjs tests/identity-review-fixtures.mjs tests/identity-review-postgres.mjs tests/identity-review-ui.mjs
python3 candidates/identity-review/qualify-build.py
```

The PostgreSQL runner creates only its own disposable `--network none` container,
with tmpfs data and a private temporary Unix socket. It publishes no ports, uses
no production credentials/mounts, and removes its own container in `finally`.
The schema preview executes only there. The repository requires both an explicit
qualification option and a database name matching
`alrifai_identity_qualification_*`; `alrifai` is rejected before any write.

The build runner copies source into a private temporary tree and adds a preview
page **only in that copy**. It runs `next build --webpack` in a network-none,
nonroot, read-only-root container with a 2 GiB memory cap and read-only existing
dependencies. It starts no server and publishes no route. The initial 768 MiB
attempt exhausted the TypeScript worker heap; the bounded 2 GiB rerun passed.
Temporary reports are under `/tmp/alrifai-identity-review-20261012/`. Temporary
retention is not a backup guarantee.

## Integration gates

There are no real named users, Owner-approved grants or live group registrations
in this candidate. The approval verifier defaults to deny. The test verifier,
passwords, staff, grants, group approvals and spelling alias approvals are
explicitly synthetic controls, never provisioning instructions.

Host integration must separately qualify HTTPS, trusted peer attribution, cookie
handling, browser interactions, approved named-account provisioning, exact
binding evidence and a real read-only MCP client. An activation option cannot
turn this qualification repository into a production writer. Any approved future
registry persistence adapter, least-privilege database grants, migration and host
route registration require their own reviewed change and authorization.

Review note updates affect only the authenticated intake owner's pending review,
with exact version/authorization-epoch checks. Verification/approval of operational
records, field correction workflows, reassignment and staff lifecycle beyond
approved initial provisioning/revocation are not implemented.

The pilot serializes transactions and stops at 5,000 records / 32 MiB state;
list endpoints page 25 rows. Full per-item history/source views remain bounded by
that pilot limit. Production-scale history pagination, retention and capacity
qualification remain open. Sending, posting, media acquisition and providers are
disabled. PAY-001–012, employee-mobile-v3 and Historical Level B closure are
unchanged.
