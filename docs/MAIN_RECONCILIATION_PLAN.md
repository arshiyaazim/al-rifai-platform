# `main` reconciliation plan — 2026-11-07

**Status:** PREPARED ONLY. **No merge, reset, force-push or rewrite was
performed.** `main` and `feature/phase3-router-cash-vessel` remain divergent and
intact.

---

## 1. Verified Git state (read-only)

| Item | Value |
|---|---|
| `main` | `0861e05` (clean, checked out in `/opt/al-rifai-platform`) |
| Feature branch | `70fcebe` at the time of this snapshot; head has since advanced with documentation commits (`fd23fcf`, `2cc00fa` — see `git log`). Clean, checked out in `/opt/al-rifai-phase3-test`, pushed to `origin` |
| Merge base | `76d5d00b86dfae3502ebeea9d7c91c98c9cf6ab7` |
| `git rev-list --left-right --count main...HEAD` | **22 main-only / 17 feature-only** commits at snapshot (22 / 19 with the two later docs commits) |
| Main-only commits | `0861e05`, `00455c0`, `9fcc2e7`, `21c7103`, `a0884e2`, `6771626`, `faeac2c`, `0f717f4`, `85206d0`, `efc0b07`, `3285f56`, `0223c91`, `72a7656`, `c322e63`, `408e358`, `3d9e9ef`, `2f504b2`, `326145f`, `474b148`, `a79c929`, plus earlier docs merges |
| Feature-only commits (at snapshot) | `70fcebe`, `4d3ed07`, `c738721`, `3e0dd01`, `00e25a7`, `cfd3f99`, `62e6ff2`, `675a3ef`, `d533939`, `ed78ec2`, `9398fca`, `0000cf0`, `1f50321`, `e3e8537`, `7da17f1`, `ecdd186`, `8b9b779` — plus later docs commits `fd23fcf`, `2cc00fa` |

The history contains criss-cross merges: several main-only commits are docs
merge commits whose content is also present on the feature branch. This is why a
simple fast-forward is impossible and why **no automatic merge is safe without
review**.

## 2. README divergence (root cause of this task)

Both READMEs still opened with a `v1.4.0-phase3-rc2` / schema 1.4.0 /
`phase3-rc-final5` "Current Release" block, while the live release is
`phase3-ai-rc-7da17f1` / schema 1.5.0 / migrations 002–009.

- **Feature branch README** has now been corrected (this task) with a
  `Release status` table distinguishing Current Production / Historical Release
  / Built but Not Deployed / Pending Migration & Activation, plus corrections to
  schema, routing flags, AI availability, installer counts, test counts and
  stale cutover-era validation claims. All historical tags, rollback
  instructions and cutover history are preserved.
- **`main` README** is **still stale**: it additionally claims runtime image
  `86d659a`, candidate `9e85e49` "not deployed", and `/assistant` deployed on
  that candidate. It must be reconciled from the corrected feature-branch
  version — not overwritten with unrelated content.

## 3. Files expected to conflict on merge

`README.md`, `NEXT-HANDOFF.md`, `PHASE3_FILE_MANIFEST.md`,
`docs/PROJECT_KNOWLEDGE.md`, `docs/PRODUCTION_URLS.md`,
`docs/BUSINESS_WORKFLOW_BACKLOG.md`, and possibly `docs/PHASE3_GO_NO_GO_7da17f1.md`.
These exist on both sides with different content.

## 4. Recommended reconciliation (Owner approval required first)

**Option A — GitHub Pull Request (recommended, safest):**

1. Open a PR `feature/phase3-router-cash-vessel` → `main` on
   `arshiyaazim/al-rifai-platform`.
2. Review the diff. For documentation conflicts, take the **feature-branch
   version** (it is the reconciled, verified state); keep main-only commits as
   ancestors so no history is lost.
3. Merge with a merge commit (`--no-ff` equivalent). Do **not** squash or
   rebase, so main-only commits remain visible.
4. After merge verify `git log main ^76d5d00` still contains all 22 main-only
   commits and the 17 feature commits; verify `main` README matches the
   corrected feature README; verify no force-push occurred.

**Option B — local merge in the canonical worktree:**

```bash
cd /opt/al-rifai-platform
git status --porcelain            # must be empty
git merge --no-ff origin/feature/phase3-router-cash-vessel -m "Merge Phase 3 release docs and fixes"
# resolve documentation conflicts by taking the feature-branch versions
git diff --check
git push origin main              # normal push, never --force
```

## 5. Explicitly prohibited

- `git reset --hard`, `git push --force`, `git rebase` on `main`.
- Squashing or dropping any main-only commit.
- Overwriting unrelated main-only docs/commits.
- Merging before the Owner approves the reconciliation.
- Deploying or migrating as part of a documentation merge.

## 6. Release-image provenance (must stay explicit)

- Production image `phase3-ai-rc-7da17f1` was built from commit `7da17f1`.
- Feature head (see `git log`; `70fcebe` at this snapshot) contains
  post-`7da17f1` **code and docs that are NOT deployed** (workflow fixes,
  durable delivery store, pending migration 010, README reconciliation).
- Merging the branch into `main` does **not** deploy anything and does **not**
  change the running image. A separate release procedure (fresh backup, new
  candidate, Owner approval) is required for that.

## 7. Do not change the active goal

**Active goal: Authenticated Production UI Verification.** It is **BLOCKED**,
not complete: login is OWNER-CONFIRMED, but AGENT-VERIFIED authenticated UI is
NOT TESTED because no production session cookie is available to the Agent.
Specific Owner action: write one valid `__Host-alrifai_cash` cookie into
`/etc/vps/apps/al-rifai/verification-session.cookies` (`root:root`, `400`) or
run `scripts/owner-assisted-ui-verify.sh` and share only its non-secret output.
A README correction or a `main` merge does **not** complete this goal.
