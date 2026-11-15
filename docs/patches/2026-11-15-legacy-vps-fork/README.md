# Legacy `/opt/vps` fork — preserved patches (2026-11-15)

These files are **archived evidence only**. Do not apply them blindly.

## Origin

- Repository: `/opt/vps` → `git@github.com:arshiyaazim/opt_vps.git`
- Branch: `target01-vessel-fragment-merge` (never pushed, no upstream)
- Base: `origin/main` @ `8096ed8`

## What is here

| File | Content |
|---|---|
| `0001-…patch` | `fix(vessel): one logical order per business identity across fragments` |
| `0002-…patch` | `fix(vessel): require an exact duty day and a compatible Mother Vessel` |
| `0003-…patch` | `docs: record Target 01/02 production position and deployment risks` |
| `uncommitted-19-files.patch` | 19 modified files in the working tree (+1048 / −183) |
| `untracked.txt` | untracked paths (`al-rifai-standalone/`, `reports/`) |

## Why they are not cherry-picked

The legacy fork and this repository are two generations of the same application
(236 shared paths, 196 byte-identical files). They do **not** share a file
layout:

- legacy: `apps/al-rifai/lib/vessel-match.ts`, `apps/al-rifai/compose.yaml`
- here:   `lib/vessel-match.ts`, `compose.yaml`

`git am` / `git cherry-pick` will fail on the `apps/al-rifai/` prefix.

## Equivalents already present in this repository

The intent of both code commits is already represented, in evolved form:

| Legacy fix | Current implementation |
|---|---|
| one logical order per business identity | `lib/vessel-match.ts`, `lib/vessel-ops.ts` |
| exact duty day | `lib/release-scan.ts`, `lib/release-parser.ts`, `lib/vessel-reports.ts` |

## Uncommitted work assessment

Of the 19 modified files:

- `lib/cash-publish.ts`, `lib/cash-scope.ts` — **byte-identical** to this repo (already upstream)
- `lib/history-extraction.mjs` — legacy version (160 lines) vs 251 lines here (superseded)
- `scripts/backfill-approved.mjs` — does **not** exist here (legacy-only tool)
- `tests/cash-intake-safety.mjs` — does **not** exist here
- `docs/OWNER_BUSINESS_POLICY.md` — does **not** exist here

So the only genuinely unique content is one legacy backfill script, one test file
and one policy document. Read them before deciding whether they matter.

## Restoring the original branch

The full history is also captured as `vps-foundation-history.bundle` inside every
nightly encrypted recovery archive (`/var/backups/vps/al-rifai/recovery-*.tar.gpg`).
