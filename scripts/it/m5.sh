# Milestone 5 live checks. Sourced by scripts/integration-test.sh (uses its helpers).
# - Approve in GitHub mode: push, pull request, squash-merge; branch protection
#   leaves the pull request waiting for review; the sync picks up a reviewer's merge.
#   GitHub is a local stand-in (email-service/tests/fake-github.ts): a real git
#   server (git http-backend) plus the pull-request API. Nothing leaves this machine.
# - Real SMTP: the email service logs in (user + password file) and must use STARTTLS.
#   The server is Mailpit with a password file and its own certificate.
# - The GitHub token is nowhere in Paperclip and unreadable for another OS user.
# Then the deployment rehearsal (scripts/deploy-rehearsal.sh) runs on its own ports.

M5_DIR="$ROOT/.paperclip-data/m5-it"
rm -rf "$M5_DIR" && mkdir -p "$M5_DIR/secrets" && chmod 700 "$M5_DIR/secrets"
M5_LINKS="http://127.0.0.1:3298"
M5_GH_PORT=3297
M5_SMTP_PORT=1027
M5_MP_API="http://127.0.0.1:8027/api/v1"

MAILPIT_VERSION="v1.27.0"
MAILPIT_SHA256="629d29442499976ebe271570bac07106c2a0667ba37d2358efbbaff25fd583a1"
MAILPIT="$(command -v mailpit || echo "$ROOT/.vendor/mailpit/mailpit")"
if [ ! -x "$MAILPIT" ]; then
  [ "$(uname -s)/$(uname -m)" = "Linux/x86_64" ] || { echo "  install Mailpit first (on a Mac: brew install mailpit)"; exit 1; }
  mkdir -p "$ROOT/.vendor/mailpit-dl" "$ROOT/.vendor/mailpit"
  curl -sSL -o "$ROOT/.vendor/mailpit-dl/mailpit.tar.gz" "https://github.com/axllent/mailpit/releases/download/$MAILPIT_VERSION/mailpit-linux-amd64.tar.gz"
  echo "$MAILPIT_SHA256  $ROOT/.vendor/mailpit-dl/mailpit.tar.gz" | sha256sum -c --quiet - || { echo "Mailpit download does not match the pinned checksum"; exit 1; }
  tar -xzf "$ROOT/.vendor/mailpit-dl/mailpit.tar.gz" -C "$ROOT/.vendor/mailpit" mailpit
fi
m5_started() { # name pid
  EXTRA_PIDS="$EXTRA_PIDS $2"
  sleep 1
  kill -0 "$2" 2>/dev/null || { echo "  $1 did not start; see $LOG_DIR/$1.log"; tail -5 "$LOG_DIR/$1.log"; exit 1; }
}
m5_rand() { node -e "process.stdout.write(require('crypto').randomBytes(${1:-24}).toString('hex'))"; }

echo "-- a mail server that needs a password and STARTTLS (Mailpit with its own certificate)"
openssl req -x509 -newkey rsa:2048 -nodes -days 2 -subj "/CN=localhost" -addext "subjectAltName=DNS:localhost,IP:127.0.0.1" \
  -keyout "$M5_DIR/smtp.key" -out "$M5_DIR/smtp.crt" >/dev/null 2>&1
M5_SMTP_PASS=$(m5_rand 16)
printf '%s' "$M5_SMTP_PASS" >"$M5_DIR/secrets/smtp-pass" && chmod 600 "$M5_DIR/secrets/smtp-pass"
printf 'briefing@example.com:%s\n' "$(openssl passwd -apr1 "$M5_SMTP_PASS")" >"$M5_DIR/smtp-users"
unset M5_SMTP_PASS
"$MAILPIT" --smtp "127.0.0.1:$M5_SMTP_PORT" --listen 127.0.0.1:8027 --disable-version-check \
  --smtp-auth-file "$M5_DIR/smtp-users" --smtp-tls-cert "$M5_DIR/smtp.crt" --smtp-tls-key "$M5_DIR/smtp.key" --smtp-require-starttls \
  --database "$M5_DIR/mailpit.db" >"$LOG_DIR/mailpit-m5.log" 2>&1 &
m5_started mailpit-m5 $!
for _ in $(seq 1 20); do curl -s -m 1 "$M5_MP_API/messages" >/dev/null 2>&1 && break; sleep 0.5; done

echo "-- a stand-in GitHub with the project's repository"
M5_GH_TOKEN_FILE="$M5_DIR/secrets/github-token"
printf '%s' "$(m5_rand 20)" >"$M5_GH_TOKEN_FILE" && chmod 600 "$M5_GH_TOKEN_FILE"
(cd "$ROOT/email-service" && exec node tests/fake-github.ts "$M5_GH_PORT" "$M5_DIR/github" acme/app "$M5_GH_TOKEN_FILE") >"$LOG_DIR/fake-github.log" 2>&1 &
m5_started fake-github $!
for _ in $(seq 1 20); do [ -f "$M5_DIR/github/ready" ] && break; sleep 0.5; done
M5_GH="http://127.0.0.1:$M5_GH_PORT"
m5_gh_git() { git --git-dir "$M5_DIR/github/acme/app.git" "$@"; }

# The project repository Paperclip works in, cloned from "GitHub" (as on the server).
M5_SEED="$M5_DIR/seed" && mkdir -p "$M5_SEED" && git -C "$M5_SEED" init -q -b main && echo hi >"$M5_SEED/README.md"
git -C "$M5_SEED" add README.md && git -C "$M5_SEED" -c user.email=t@example.com -c user.name=T commit -q -m init
git -C "$M5_SEED" -c push.negotiate=false push -q "$M5_DIR/github/acme/app.git" main
M5_REPO="$ROOT/.paperclip-data/it-repos/m5-$(date +%s)"
git clone -q "$M5_DIR/github/acme/app.git" "$M5_REPO"

echo "-- company, project, agent, settings in GitHub mode"
M5_H=$(date -u +%-H)
M5_N=$((10 - M5_H)); [ "$M5_N" -gt 14 ] && M5_N=$((M5_N - 24)); [ "$M5_N" -lt -12 ] && M5_N=$((M5_N + 24))
if [ "$M5_N" -ge 0 ]; then M5_TZ="Etc/GMT-$M5_N"; else M5_TZ="Etc/GMT+$((-M5_N))"; fi
api PATCH /api/instance/settings/experimental '{"enableIsolatedWorkspaces":true}'
api POST /api/companies "{\"name\":\"VT M5 $(date +%s)\"}"
M5_CID=$(echo "$API_BODY" | json 'd.id')
api POST "/api/companies/$M5_CID/projects" "{\"name\":\"app\",\"executionWorkspacePolicy\":{\"enabled\":true,\"defaultMode\":\"isolated_workspace\",\"allowIssueOverride\":true,\"workspaceStrategy\":{\"type\":\"git_worktree\"}},\"workspace\":{\"name\":\"app\",\"sourceType\":\"local_path\",\"cwd\":\"$M5_REPO\",\"isPrimary\":true}}"
M5_PID=$(echo "$API_BODY" | json 'd.id')
api POST "/api/companies/$M5_CID/agents" '{"name":"Cy night agent","role":"engineer","adapterType":"process","adapterConfig":{"command":"pwd"}}'
M5_A=$(echo "$API_BODY" | json 'd.id')
api PATCH "/api/agents/$M5_A/permissions" '{"canCreateAgents":false,"canCreateSkills":false,"canAssignTasks":true}'
api POST "/api/companies/$M5_CID/secrets" "{\"name\":\"vt-link-signing\",\"key\":\"vt-link-signing\",\"value\":\"$(m5_rand 32)\"}"
M5_SID=$(echo "$API_BODY" | json 'd.id')
m5_config() { # nightStartHour [github json]
  local gh="${2:-}"; [ -n "$gh" ] || gh='{"repo":"acme/app"}'
  api POST "/api/plugins/$PLUGIN_ID/config" "{\"companyId\":\"$M5_CID\",\"configJson\":{
    \"links\":{\"baseUrl\":\"$M5_LINKS\",\"signingSecret\":{\"type\":\"secret_ref\",\"secretId\":\"$M5_SID\"}},
    \"github\":$gh,
    \"night\":{\"projectId\":\"$M5_PID\"},\"checks\":{\"testCommand\":\"test -f README.md\"},\"people\":[
    {\"email\":\"cy@example.com\",\"agentId\":\"$M5_A\",\"timezone\":\"$M5_TZ\",\"nightStartHour\":$1,\"nightBudgetCapCents\":1000}]}}"
}
m5_config 11 '{"repo":"acme/app","token":"not-allowed-here"}'
check "M5: Paperclip refuses a GitHub token in the plugin settings" "$API_STATUS" "400"
m5_config 11
check "M5: save settings in GitHub mode (repository name only)" "$API_STATUS" "200"

echo "-- the email service: SMTP login + STARTTLS, GitHub token from a file"
(cd "$ROOT/email-service" && unset GITHUB_TOKEN && PAPERCLIP_URL="$BASE" VT_COMPANY_ID="$M5_CID" LISTEN_PORT=3298 POLL_SECONDS=2 \
  SMTP_HOST=127.0.0.1 SMTP_PORT=$M5_SMTP_PORT SMTP_REQUIRE_TLS=true SMTP_CA_FILE="$M5_DIR/smtp.crt" \
  SMTP_USER=briefing@example.com SMTP_PASS_FILE="$M5_DIR/secrets/smtp-pass" MAIL_FROM="Vision and Tom <briefing@example.com>" \
  GITHUB_TOKEN_FILE="$M5_GH_TOKEN_FILE" GITHUB_API_URL="$M5_GH/api" GITHUB_GIT_URL="$M5_GH" GITHUB_SYNC_MINUTES=1 \
  STATE_DIR="$M5_DIR/email-state" exec node src/main.ts) >"$LOG_DIR/email-service-m5.log" 2>&1 &
M5_ES_PID=$!
m5_started email-service-m5 $M5_ES_PID
for _ in $(seq 1 20); do curl -s -m 1 "$M5_LINKS/health" >/dev/null 2>&1 && break; sleep 0.5; done
check "M5: email service is up" "$(curl -s "$M5_LINKS/health")" "ok"

api GET "/api/plugins/$PLUGIN_ID/jobs"
M5_JOB=$(echo "$API_BODY" | json 'd.find(j=>j.jobKey==="night-tick").id')
m5_tick() {
  api POST "/api/plugins/$PLUGIN_ID/jobs/$M5_JOB/trigger" '{}'
  local run; run=$(echo "$API_BODY" | json 'd.runId')
  for _ in $(seq 1 30); do
    api GET "/api/plugins/$PLUGIN_ID/jobs/$M5_JOB/runs"
    case "$(echo "$API_BODY" | json "(d.find(r=>r.id==='$run')||{}).status")" in succeeded|failed) break ;; esac
    sleep 1
  done
}
m5_night() { api POST "/api/plugins/$PLUGIN_ID/data/night-status" "{\"companyId\":\"$M5_CID\",\"params\":{}}"; echo "$API_BODY" | json "(d.data[0]||{}).$1"; }
m5_issue() { api GET "/api/issues/$1"; echo "$API_BODY" | json "d.$2"; }
m5_event() { api POST "/api/plugins/$PLUGIN_ID/data/task-event" "{\"companyId\":\"$M5_CID\",\"params\":{\"taskId\":\"$1\"}}"; echo "$API_BODY" | json "d.data.$2"; }
m5_run() {
  local id=""
  for _ in $(seq 1 90); do
    api GET "/api/companies/$M5_CID/heartbeat-runs"
    id=$(echo "$API_BODY" | json "(Array.isArray(d)?d:d.items).filter(r=>r.agentId==='$M5_A').map(r=>r.id)[0]")
    [ -n "$id" ] && break; sleep 1
  done
  echo "$id"
}
m5_tool() { api POST /api/plugins/tools/execute "{\"tool\":\"$PLUGIN_KEY:$1\",\"parameters\":$2,\"runContext\":{\"agentId\":\"$M5_A\",\"runId\":\"$(m5_run)\",\"companyId\":\"$M5_CID\",\"projectId\":\"$M5_PID\"}}"; }
m5_idle() {
  for _ in $(seq 1 60); do
    api GET "/api/companies/$M5_CID/heartbeat-runs"
    [ "$(echo "$API_BODY" | json "(Array.isArray(d)?d:d.items).filter(r=>r.agentId==='$M5_A'&&['queued','running'].includes(r.status)).length")" = "0" ] && return
    sleep 1
  done
}
m5_worktree() {
  local ew=""
  for _ in $(seq 1 45); do ew=$(m5_issue "$1" executionWorkspaceId); [ -n "$ew" ] && break; sleep 2; done
  api GET "/api/execution-workspaces/$ew"; echo "$API_BODY" | json 'd.cwd'
}
m5_work() { # taskId file
  local wt; wt=$(m5_worktree "$1")
  echo "change for $2" >"$wt/$2"
  git -C "$wt" add "$2" && git -C "$wt" -c user.email=agent@example.com -c user.name=Agent commit -q -m "Work on $2"
  m5_tool run_checks "{\"issueId\":\"$1\"}"
  m5_idle; api PATCH "/api/issues/$1" '{"status":"done"}'
  echo "$wt"
}

echo "-- a night for Cy with two tasks"
m5_tick
m5_tool propose_tonight '{"tasks":[{"title":"Add greeting"},{"title":"Add farewell"}]}'
M5_T1=$(echo "$API_BODY" | json 'd.result.data.taskIds[0]'); M5_T2=$(echo "$API_BODY" | json 'd.result.data.taskIds[1]')
M5_PLAN=$(m5_night planIssueId)
api GET "/api/issues/$M5_PLAN/interactions"
api POST "/api/issues/$M5_PLAN/interactions/$(echo "$API_BODY" | json '(Array.isArray(d)?d:d.items).find(i=>i.kind==="request_confirmation").id')/accept" '{}'
m5_tick
m5_config 10 && m5_tick
M5_WT1=$(m5_work "$M5_T1" greeting.txt | tail -1)
m5_tick
M5_WT2=$(m5_work "$M5_T2" farewell.txt | tail -1)
m5_tick
check "M5: Cy's night finished" "$(m5_night status)" "finished"
m5_config 1 && m5_tick

echo "-- the morning email arrives through the password-protected STARTTLS server"
for _ in $(seq 1 30); do [ "$(curl -s "$M5_MP_API/messages" | json 'd.total')" = "1" ] && break; sleep 1; done
check "M5: one email delivered after SMTP login over STARTTLS" "$(curl -s "$M5_MP_API/messages" | json 'd.messages.map(m=>m.To[0].Address).join(",")')" "cy@example.com"
M5_MAIL=$(curl -s "$M5_MP_API/message/$(curl -s "$M5_MP_API/messages" | json 'd.messages[0].ID')" | json 'd.Text' | tr -d '\r')
M5_APPROVE1=$(echo "$M5_MAIL" | grep '^  Approve: ' | sed -n 1p | sed 's/^  Approve: //')
M5_APPROVE2=$(echo "$M5_MAIL" | grep '^  Approve: ' | sed -n 2p | sed 's/^  Approve: //')
check "M5: two Approve links" "$([ -n "$M5_APPROVE1" ] && [ -n "$M5_APPROVE2" ] && echo yes)" "yes"
check "M5: the email says undecided tasks come back with fresh links" "$(echo "$M5_MAIL" | grep -c "comes back in the next morning's email with fresh links")" "1"
m5_post() { curl -s -X POST -H 'content-type: application/x-www-form-urlencoded' --data "${2:-}" "$1"; }

echo "-- Approve pushes the branch, opens a pull request and squash-merges it"
check "M5: the confirm page names GitHub" "$(curl -s "$M5_APPROVE1" | grep -c 'to GitHub (acme/app), open a pull request and merge it')" "1"
M5_HEAD1=$(git -C "$M5_WT1" rev-parse HEAD)
M5_OUT=$(m5_post "$M5_APPROVE1")
check "M5: page says Merged" "$(echo "$M5_OUT" | grep -oE '<h1>[^<]*</h1>')" "<h1>Merged</h1>"
check "M5: GitHub has the task branch at exactly the approved commit" "$(m5_gh_git rev-parse "refs/heads/$(git -C "$M5_WT1" rev-parse --abbrev-ref HEAD)")" "$M5_HEAD1"
check "M5: GitHub main got one squashed commit with the change" "$(m5_gh_git show main:greeting.txt)/$(m5_gh_git log --format=%P -1 main | wc -w | tr -d ' ')" "change for greeting.txt/1"
check "M5: the pull request is merged" "$(curl -s -X POST "$M5_GH/__control/state" | json 'd.pulls[0].merged')" "true"
check "M5: event log says accepted, ticket done" "$(m5_event "$M5_T1" outcome)/$(m5_issue "$M5_T1" status)" "accepted/done"
check "M5: a second click does nothing" "$(m5_post "$M5_APPROVE1" | grep -oE '<h1>[^<]*</h1>')/$(curl -s -X POST "$M5_GH/__control/state" | json 'd.pulls.length')" "<h1>Already done</h1>/1"

echo "-- branch protection blocks the merge: the pull request waits for review"
curl -s -X POST "$M5_GH/__control/protection?on=1" >/dev/null
M5_OUT=$(m5_post "$M5_APPROVE2")
check "M5: page says Waiting for review" "$(echo "$M5_OUT" | grep -oE '<h1>[^<]*</h1>')" "<h1>Waiting for review</h1>"
check "M5: the page gives GitHub's reason and the pull request" "$(echo "$M5_OUT" | grep -c 'approving review is required.*pull/2')" "1"
check "M5: the pull request stays open, main unchanged" "$(curl -s -X POST "$M5_GH/__control/state" | json 'd.pulls[1].state')/$(m5_gh_git cat-file -e main:farewell.txt 2>/dev/null && echo merged || echo not-merged)" "open/not-merged"
check "M5: task undecided, ticket in review" "$(m5_event "$M5_T2" outcome)/$(m5_issue "$M5_T2" status)" "/in_review"
api GET "/api/plugins/$PLUGIN_KEY/api/prs/waiting?companyId=$M5_CID"
check "M5: the plugin lists it as waiting" "$(echo "$API_BODY" | json 'd.pullRequests.map(p=>p.number).join(",")')" "2"

echo "-- a reviewer merges it on GitHub; the next sync records it"
curl -s -X POST "$M5_GH/__control/protection?on=0" >/dev/null
curl -s -X POST "$M5_GH/__control/merge/2" >/dev/null
for _ in $(seq 1 45); do [ "$(m5_event "$M5_T2" outcome)" = "accepted" ] && break; sleep 2; done
check "M5: after review, event log says accepted and ticket done" "$(m5_event "$M5_T2" outcome)/$(m5_issue "$M5_T2" status)" "accepted/done"

echo "-- the GitHub token: only the email service has it"
M5_GH_TOKEN=$(cat "$M5_GH_TOKEN_FILE")
check "M5: GitHub saw the token on every request (it was really used)" "$(curl -s -X POST "$M5_GH/__control/state" | json 'd.requests.every(r=>r.authorized)&&d.requests.length>5')" "true"
M5_DUMP="$M5_DIR/paperclip-dump.sql"
"${PC[@]}" db:backup --data-dir "$DATA_DIR" --dir "$M5_DIR/backup" --filename-prefix m5 >/dev/null 2>&1
gunzip -c "$M5_DIR"/backup/m5-*.sql.gz >"$M5_DUMP" 2>/dev/null
check "M5: Paperclip's whole database (dumped) has the plugin's data" "$(grep -c 'pull/2' "$M5_DUMP" | awk '{print ($1>0)?"yes":"no"}')" "yes"
check "M5: ...and does not contain the GitHub token" "$(grep -c "$M5_GH_TOKEN" "$M5_DUMP")" "0"
check "M5: no file in Paperclip's data folder contains it" "$(grep -rlF "$M5_GH_TOKEN" "$DATA_DIR" 2>/dev/null | wc -l | tr -d ' ')" "0"
M5_PC_PIDS=$(pgrep -f "paperclipai@$PAPERCLIP_VERSION|plugin-worker|dist/worker.js" || true)
M5_IN_ENV=0; for p in $M5_PC_PIDS; do tr '\0' '\n' <"/proc/$p/environ" 2>/dev/null | grep -qF "$M5_GH_TOKEN" && M5_IN_ENV=1; done
check "M5: not in the environment of Paperclip or its plugin workers (where agents run)" "$M5_IN_ENV/$([ "$(echo "$M5_PC_PIDS" | wc -w)" -ge 2 ] && echo looked)" "0/looked"
check "M5: not in the email service's own environment either (it is read from a file)" "$(tr '\0' '\n' <"/proc/$M5_ES_PID/environ" | grep -cF "$M5_GH_TOKEN")" "0"
# On the server, agents run as the 'paperclip' user and the token file belongs to
# root (read by systemd for the email service only). Here the stand-in for the
# agents' user is 'nobody'.
check "M5: another OS user (stand-in for the agents' user) cannot read the token file" "$(setpriv --reuid=nobody --regid=nogroup --clear-groups cat "$M5_GH_TOKEN_FILE" >/dev/null 2>&1 && echo readable || echo refused)" "refused"
check "M5: ...nor the email service's memory map/environment" "$(setpriv --reuid=nobody --regid=nogroup --clear-groups cat "/proc/$M5_ES_PID/environ" >/dev/null 2>&1 && echo readable || echo refused)" "refused"
check "M5: the token never appears in the email service's log" "$(grep -cF "$M5_GH_TOKEN" "$LOG_DIR/email-service-m5.log")" "0"
unset M5_GH_TOKEN
rm -f "$M5_DUMP"

echo "-- wrong SMTP password: nothing is marked sent, nothing is lost"
printf 'wrong-password' >"$M5_DIR/secrets/smtp-pass-wrong"
M5_OUT=$(cd "$ROOT/email-service" && unset GITHUB_TOKEN && PAPERCLIP_URL="$BASE" VT_COMPANY_ID="$M5_CID" SMTP_HOST=127.0.0.1 SMTP_PORT=$M5_SMTP_PORT SMTP_REQUIRE_TLS=true \
  SMTP_CA_FILE="$M5_DIR/smtp.crt" SMTP_USER=briefing@example.com SMTP_PASS_FILE="$M5_DIR/secrets/smtp-pass-wrong" VT_INVITE_NO_EMAIL=0 \
  node src/invite.ts dee@example.com Europe/Paris 2>&1 || true)
check "M5: invite command reports the email could not be sent (and prints the link)" "$(echo "$M5_OUT" | grep -c 'could not be sent')/$(echo "$M5_OUT" | grep -c "$M5_LINKS/join/")" "1/1"
check "M5: the SMTP password never shows in that output" "$(echo "$M5_OUT" | grep -c 'wrong-password')" "0"

if [ "${SKIP_REHEARSAL:-0}" != "1" ]; then
  echo "== deployment rehearsal (scripts/deploy-rehearsal.sh)"
  REH_OUT="$LOG_DIR/deploy-rehearsal.log"
  bash "$ROOT/scripts/deploy-rehearsal.sh" 2>&1 | tee "$REH_OUT" | sed 's/^/  /'
  REH_P=$(sed -n 's/^Result: \([0-9]*\) passed, \([0-9]*\) failed$/\1/p' "$REH_OUT")
  REH_F=$(sed -n 's/^Result: \([0-9]*\) passed, \([0-9]*\) failed$/\2/p' "$REH_OUT")
  PASS=$((PASS + ${REH_P:-0})); FAIL=$((FAIL + ${REH_F:-1}))
fi
