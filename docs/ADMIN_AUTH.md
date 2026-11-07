# Production Admin Authentication

**Status:** explicit provisioning mechanism implemented and verified on an isolated clone.
Production Admin login is pending one Owner-supplied credential action.

---

## 1. Verified root cause

- `/opt/vps/al-rifai-standalone/apps/al-rifai/.env` contains only commented placeholders:
  `ALRIFAI_BOOTSTRAP_ADMIN_USERNAME=owner`, an **empty** password, and a name.
- The container does not receive any bootstrap Admin variable.
- Production has an `Admin` account (role ADMIN, active), whose PBKDF2 hash is
  byte-identical to the legacy `alrifai` and `alrifai_v2` Admin hash.
- Login matches usernames case-insensitively, but `owner` is a different
  username from `Admin`. The login API uses PostgreSQL, not `.env`.
- No failed-login throttle/audit record is present; this is a credential/
  provisioning mismatch, not a lockout, origin failure or hash incompatibility.

Therefore the `.env` Admin requirement was documented but not operational: no
password exists there, no provisioning ran, and the configured username does not
match the existing Admin account.

---

## 2. Provisioning mechanism

`scripts/standalone/provision-admin.mjs` (also `pnpm admin:provision`):

- reads `ALRIFAI_BOOTSTRAP_ADMIN_USERNAME`, `_PASSWORD` (or `_PASSWORD_FILE`), `_NAME`;
- default is **check only** — no writes;
- `--apply` creates a missing Admin;
- if the account exists and the password matches, no change;
- if the account exists with a different password, it **fails** unless
  `--reset-password` is explicitly supplied;
- it never runs at application startup, so a restart cannot reset a password;
- it uses the same PBKDF2 format as login and installer;
- it writes `ADMIN_PROVISIONED` / `ADMIN_PASSWORD_RESET` audit events;
- it never prints a password or hash.

### Isolated verification

A temporary clone-only Admin was created, logged in successfully (role ADMIN),
a wrong password returned 401, an explicit reset changed the password
(new 200 / old 401), and a non-reset mismatch was refused with
`PASSWORD_MISMATCH_RESET_REQUIRED`.

---

## 3. Secure production setup

Do not put a password in chat, shell history, Git or logs. On the VPS:

```bash
install -m 400 -o root -g root /dev/null /etc/vps/apps/al-rifai/admin-bootstrap-password
# write the intended Admin password into that file using the Owner's secure method
# (or use an existing secret manager to mount it)

# edit the root-only .env:
#   ALRIFAI_BOOTSTRAP_ADMIN_USERNAME=Admin
#   ALRIFAI_BOOTSTRAP_ADMIN_PASSWORD_FILE=/etc/vps/apps/al-rifai/admin-bootstrap-password
#   ALRIFAI_BOOTSTRAP_ADMIN_NAME=Owner
```

Then verify (no write):

```bash
cd /opt/al-rifai-platform
node --env-file=/opt/vps/al-rifai-standalone/apps/al-rifai/.env \
  --experimental-strip-types scripts/standalone/provision-admin.mjs
```

If `password_matches: true`, the existing Admin password can be used and no
reset is needed. If false, the password is not the current stored credential;
either supply the correct one or explicitly authorize a reset:

```bash
node ... provision-admin.mjs --apply --reset-password
```

`.env` is read by an explicit command, not by the running application at
startup; this preserves the requirement that ordinary restarts never reset
credentials.

---

## 4. Remaining Owner action

The production `.env` has no password and the configured username `owner` does
not exist. Provide the intended Admin password through the root-only file above
using username `Admin` (existing account), then request the check/apply step.
No production password was changed or invented.

---

## 5. Production configuration state (2026-11-07)

The production `.env` now contains the supported references:

```dotenv
ALRIFAI_BOOTSTRAP_ADMIN_USERNAME=Admin
ALRIFAI_BOOTSTRAP_ADMIN_PASSWORD_FILE=/etc/vps/apps/al-rifai/admin-bootstrap-password
ALRIFAI_BOOTSTRAP_ADMIN_NAME=Admin
ALRIFAI_APP_USER_1_USERNAME=officeassistant
ALRIFAI_APP_USER_1_PASSWORD_FILE=/etc/vps/apps/al-rifai/user-1-password
ALRIFAI_APP_USER_2_USERNAME=officeazzistant2
ALRIFAI_APP_USER_2_PASSWORD_FILE=/etc/vps/apps/al-rifai/user-2-password
```

The three password files exist with mode `400 root:root` and **zero bytes**.
No password was invented or written. Provisioning checks report
`password_configured: false`; the existing `Admin`, `officeassistant` and
`officeazzistant2` accounts are active with the correct roles.

### Secure interactive password entry (Owner runs on the VPS)

```bash
cd /opt/al-rifai-platform
node --experimental-strip-types scripts/standalone/set-secret-password.mjs \
  --file=/etc/vps/apps/al-rifai/admin-bootstrap-password
node --experimental-strip-types scripts/standalone/set-secret-password.mjs \
  --file=/etc/vps/apps/al-rifai/user-1-password
node --experimental-strip-types scripts/standalone/set-secret-password.mjs \
  --file=/etc/vps/apps/al-rifai/user-2-password
```

The prompt does not echo and the password is not passed as an argument.

### Check / apply

```bash
PGHOST=172.18.0.2 node --env-file=/opt/vps/al-rifai-standalone/apps/al-rifai/.env \
  --experimental-strip-types scripts/standalone/provision-admin.mjs
PGHOST=172.18.0.2 node --env-file=/opt/vps/al-rifai-standalone/apps/al-rifai/.env \
  --experimental-strip-types scripts/standalone/provision-users.mjs
```

- Admin `password_matches: true` → existing credential works; no reset.
- Admin `password_matches: false` → Owner must explicitly authorize
  `provision-admin.mjs --apply --reset-password`.
- Users: existing accounts are reused; a mismatch requires
  `provision-users.mjs --apply --reset-password`.

The two users are role `USER`; they cannot access `/api/users` or Admin-only
financial actions. Clone verification: both logged in, `/cash` 200,
`/api/users` 403, wrong password 401.
