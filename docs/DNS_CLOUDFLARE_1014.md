# Cloudflare Error 1014 — Diagnosis and Proposed Correction

**Observed:** `https://al-rifai.iamazim.com/` → HTTP 403, body `error code: 1014`,
Ray ID `a569e5d1996d3731-FRA`, 2026-11-07 05:22 UTC.
**Canonical working host:** `https://app.al-rifai.iamazim.com`.

---

## 1. Verified DNS

Authoritative nameservers for `iamazim.com`:
`rihana.ns.cloudflare.com`, `amir.ns.cloudflare.com`.

| Name | Record | Target | Proxy |
|---|---|---|---|
| `app.al-rifai.iamazim.com` | A | `5.189.131.48` | DNS-only (origin) |
| `alrifai.iamazim.com` | A | `5.189.131.48` | DNS-only (origin) |
| `al-rifai.iamazim.com` | CNAME | `custom-domains.chatgpt.site` → 104.18.22.186 / 104.18.23.186 | Cloudflare edge |

`custom-domains.chatgpt.site` is a Cloudflare custom-hostname target controlled
by another Cloudflare account. Cloudflare forbids cross-account CNAME targets
and returns **1014**.

This is a DNS-target error, not an application, certificate or origin failure.
The origin is healthy on 443 and serves the Phase 3 app for the other two hosts.

---

## 2. Smallest supported corrections

### Option A — same-origin host + certificate SAN (preferred if no redirect desired)

1. In the Cloudflare `iamazim.com` zone, change:
   `al-rifai` CNAME `custom-domains.chatgpt.site` →
   A `5.189.131.48`, **DNS only** (grey cloud).
2. Extend the origin certificate SAN to include `al-rifai.iamazim.com`.
   Current cert SAN: `app.al-rifai.iamazim.com`, `alrifai.iamazim.com`.
   Renewal uses certbot `authenticator = standalone`; port 80 is currently
   closed, so this requires a short, approved port-80 window (or a DNS-01
   challenge with a Cloudflare API token).
3. No application code change; all three hosts serve the same app.

**Impact:** new hostname serves the app directly; existing hosts unchanged.
**Rollback:** restore the original CNAME.
**Risk:** temporary port-80 exposure for ACME; no origin port change beyond the
validation window.

### Option B — Cloudflare edge redirect (no origin certificate change)

1. Change `al-rifai` CNAME to A `5.189.131.48`, proxied (orange cloud).
2. Add a Cloudflare Redirect Rule:
   `https://al-rifai.iamazim.com/*` → `https://app.al-rifai.iamazim.com/$1`
   (301/308).
3. Cloudflare's edge certificate covers `*.iamazim.com`; the redirect responds
   at the edge, so the origin certificate does not need the new SAN.

**Impact:** `al-rifai` becomes a permanent redirect to the canonical app.
**Rollback:** remove the rule and restore the CNAME.
**Risk:** depends on Cloudflare redirect-rule behavior for all paths; test
`/login`, `/api/auth/*` and state-changing routes before enabling.

### Option C — Cloudflare Tunnel custom hostname

Not required: the origin is already directly reachable and the working hosts use
A records. A tunnel adds components without solving a current need.

---

## 3. Required access/approval

No Cloudflare API token or tunnel configuration was found on the VPS. The
correction requires one of:

- Owner/authorized Cloudflare dashboard access to the `iamazim.com` zone; or
- a scoped Cloudflare API token (`Zone:DNS:Edit`, and `Zone:Rulesets:Edit` for
  Option B) supplied through a secure local secret.

Do not change DNS, proxy status, certificates or redirect rules without this
explicit approval. Do not disable Cloudflare security features to work around
1014.

---

## 4. Canonical decision

`app.al-rifai.iamazim.com` is recommended as canonical: it is already the
configured `ALRIFAI_UNIFIED_ORIGINS` / `ALRIFAI_CASH_ORIGIN`, certificate CN and
session origin. `alrifai.iamazim.com` remains a verified legacy alias.
