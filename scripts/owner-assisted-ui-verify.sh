#!/usr/bin/env bash
# AL-RIFA'I — Owner-assisted, READ-ONLY production UI verification.
#
# The Owner runs this script on the VPS with a root-only Netscape cookie jar
# containing ONE valid production `__Host-alrifai_cash` session. The Agent never
# sees the cookie value: this script prints only derived, non-secret evidence
# (HTTP status, page heading, table/input/button counts, CSV content-type/size).
#
# Usage:
#   COOKIE_JAR=/etc/vps/apps/al-rifai/verification-session.cookies \
#   ROLE_LABEL=Admin scripts/owner-assisted-ui-verify.sh > /tmp/ui-verify.txt
#   # Owner shares /tmp/ui-verify.txt (no secrets in it), then deletes both files.
#
# Run once per role (Admin, officeassistant, officeazzistant2) to compare
# permissions. No POST, no logout, no state-changing request is made: logout
# revokes a session and requires separate explicit Owner authorisation.
#
# NO MIGRATION, NO CREDENTIAL CHANGE, NO PRODUCTION DATA CHANGE.

set -u

# Never leave response bodies (which can contain a CSRF token) on disk.
trap 'rm -f /tmp/alrifai-session.json /tmp/alrifai-page.html' EXIT

JAR="${COOKIE_JAR:-/etc/vps/apps/al-rifai/verification-session.cookies}"
LABEL="${ROLE_LABEL:-unknown-role}"
CANONICAL="https://app.al-rifai.iamazim.com"
LEGACY="https://alrifai.iamazim.com"

echo "AL-RIFA'I production UI verification (read-only)"
echo "role_label=$LABEL"
echo "generated_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo "cookie_value=NEVER_PRINTED"

if [ ! -f "$JAR" ]; then
  echo "FATAL: cookie jar not found at $JAR"
  echo "Owner action: write ONE valid production __Host-alrifai_cash cookie into"
  echo "  $JAR  (install -m 400 -o root -g root /dev/null <path>; Netscape format)"
  exit 2
fi
MODE=$(stat -c '%a' "$JAR")
OWNER=$(stat -c '%U:%G' "$JAR")
echo "cookie_jar_mode=$MODE cookie_jar_owner=$OWNER"
if ! grep -q '__Host-alrifai_cash' "$JAR"; then
  echo "FATAL: jar does not contain the production session cookie"
  exit 2
fi

strip() { perl -0777 -pe 's/<script.*?<\/script>//gs'; }

# 1. Session validity (read-only). No cookie value is echoed.
for BASE in "$CANONICAL" "$LEGACY"; do
  printf 'SESSION %-28s ' "$BASE"
  curl -s -b "$JAR" -o /tmp/alrifai-session.json -w '%{http_code}\n' --max-time 15 "$BASE/api/auth/session"
  python3 - <<'PY'
import json
try:
    d = json.load(open('/tmp/alrifai-session.json'))
    u = d.get('user') or {}
    print('  session_role=%s caps=%s mode=%s csrf_present=%s' % (
        u.get('role'), len(u.get('capabilities') or []), d.get('mode'), bool(d.get('csrf'))))
except Exception:
    print('  session_body_unparseable')
PY
done

# 2. Route matrix: status, heading, table columns, inputs, buttons.
ROUTES="
/dashboard
/cash
/cash/transactions
/cash/archive
/cash/submissions
/submissions
/vessel
/vessel/drafts
/register
/vessel-register
/vessel/register
/vessel/vessel-register
/employees
/employee
/transactions
/attendance
/reports
/review
/income-expenditure
/archive
/conversations
/message-mirror
/insights
/sources-review
/payroll
/settings
/assistant
/messages
"
echo
echo "ROUTE_MATRIX (host | route | http | h1 | th | inputs | buttons)"
for BASE in "$CANONICAL" "$LEGACY"; do
  for R in $ROUTES; do
    CODE=$(curl -s -b "$JAR" -o /tmp/alrifai-page.html -w '%{http_code}' --max-time 20 "$BASE$R")
    VIS=$(strip < /tmp/alrifai-page.html)
    H1=$(printf '%s' "$VIS" | grep -oP '<h1[^>]*>\K[^<]+' | head -1 | tr -d '\n' | cut -c1-28)
    TH=$(printf '%s' "$VIS" | grep -o '<th' | wc -l | tr -d ' ')
    IN=$(printf '%s' "$VIS" | grep -o '<input' | wc -l | tr -d ' ')
    BT=$(printf '%s' "$VIS" | grep -o '<button' | wc -l | tr -d ' ')
    printf '%-28s %-24s %s | %-28s | %s | %s | %s\n' "$BASE" "$R" "$CODE" "$H1" "$TH" "$IN" "$BT"
  done
done

# 3. Program detail + employee profile (nested URLs).
PROGRAM_ID="${PROGRAM_ID:-prog_df6a840cee55d392022df783}"
EMPLOYEE_MOBILE="${EMPLOYEE_MOBILE:-%2B8801301241783}"
echo
echo "NESTED_URLS"
for BASE in "$CANONICAL" "$LEGACY"; do
  for R in "/vessel/$PROGRAM_ID" "/employees/$EMPLOYEE_MOBILE" "/employee/$EMPLOYEE_MOBILE" "/transactions/employee/$EMPLOYEE_MOBILE"; do
    CODE=$(curl -s -b "$JAR" -o /tmp/alrifai-page.html -w '%{http_code}' --max-time 20 "$BASE$R")
    VIS=$(strip < /tmp/alrifai-page.html)
    H1=$(printf '%s' "$VIS" | grep -oP '<h1[^>]*>\K[^<]+' | head -1 | tr -d '\n' | cut -c1-28)
    TH=$(printf '%s' "$VIS" | grep -o '<th' | wc -l | tr -d ' ')
    printf '%-28s %-52s %s | %-28s | th=%s\n' "$BASE" "$R" "$CODE" "$H1" "$TH"
  done
done

# 4. CSV exports (content-type + byte size only; no business rows printed).
echo
echo "CSV_EXPORTS"
for T in employees programs attendance cash ledger payroll audit; do
  printf '%-14s ' "$T"
  curl -s -b "$JAR" -o /dev/null -w '%{http_code} %{content_type} %{size_download}\n' --max-time 20 "$CANONICAL/api/reports?type=$T"
done

# 5. Search / filters / pagination (row counts only).
echo
echo "SEARCH_FILTER_PAGINATION (rows only)"
for Q in ABM ZZZNOMATCH; do
  printf 'employees?q=%-12s ' "$Q"
  curl -s -b "$JAR" "$CANONICAL/employees?q=$Q" | strip | grep -o '<tr' | wc -l
done
for S in RELEASED ASSIGNED DRAFT; do
  printf 'vessel?state=%-10s ' "$S"
  curl -s -b "$JAR" "$CANONICAL/vessel?state=$S" | strip | grep -o '<tr' | wc -l
done
for P in 1 2; do
  printf 'cash?page=%-10s ' "$P"
  curl -s -b "$JAR" "$CANONICAL/cash?page=$P" | strip | grep -o '<tr' | wc -l
done

# 6. Role-sensitive controls (compare Admin vs USER output).
echo
echo "ROLE_CONTROL_COUNTS (forms a USER must not see)"
VIS=$(curl -s -b "$JAR" "$CANONICAL/cash" | strip)
for PAT in 'instruction.approve' 'instruction.post' 'ledger.create' 'action="decide"'; do
  printf 'cash %-24s %s\n' "$PAT" "$(printf '%s' "$VIS" | grep -o "$PAT" | wc -l | tr -d ' ')"
done
VIS=$(curl -s -b "$JAR" "$CANONICAL/settings" | strip)
for PAT in 'Add account' 'Save relay' 'Configure relay'; do
  printf 'settings %-20s %s\n' "$PAT" "$(printf '%s' "$VIS" | grep -o "$PAT" | wc -l | tr -d ' ')"
done
VIS=$(curl -s -b "$JAR" "$CANONICAL/vessel" | strip)
for PAT in 'Assign / replace escort' 'Void program' 'Create program'; do
  printf 'vessel %-22s %s\n' "$PAT" "$(printf '%s' "$VIS" | grep -o "$PAT" | wc -l | tr -d ' ')"
done

echo
echo "NOT TESTED BY THIS SCRIPT (require separate explicit Owner authorisation):"
echo "  - logout (POST /api/auth/logout revokes the session)"
echo "  - approval workflows, any form submission, any state-changing action"
echo "  - human-observed dashboard cards, table column contents, visual layout"
echo
echo "Owner: share only this output, then delete the cookie jar and this output."
