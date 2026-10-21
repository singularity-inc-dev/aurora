# Milestone 4 live checks. Sourced by scripts/integration-test.sh (uses its helpers).
# Morning briefing email (caught by Mailpit, nothing is really sent) and its
# signed, expiring, one-time Approve / Reject links served by email-service/.

MAILPIT_VERSION="v1.27.0"
MAILPIT_SHA256="629d29442499976ebe271570bac07106c2a0667ba37d2358efbbaff25fd583a1"
# Use an installed Mailpit (e.g. `brew install mailpit` on a Mac); otherwise, on
# Linux x86_64, download the pinned release into .vendor/.
MAILPIT="$(command -v mailpit || echo "$ROOT/.vendor/mailpit/mailpit")"
MAILPIT_API="http://127.0.0.1:8025/api/v1"
M4_LINKS="http://127.0.0.1:3299"
M4_EXPIRES_MINUTES=4

if [ ! -x "$MAILPIT" ] && [ "$(uname -s)/$(uname -m)" != "Linux/x86_64" ]; then
  echo "  Mailpit is needed for the M4 checks: install it (on a Mac: brew install mailpit) and run again."; exit 1
fi
if [ ! -x "$MAILPIT" ]; then
  echo "  downloading Mailpit $MAILPIT_VERSION into .vendor/ (test-only mail catcher)"
  mkdir -p "$ROOT/.vendor/mailpit-dl" "$ROOT/.vendor/mailpit"
  curl -sSL -o "$ROOT/.vendor/mailpit-dl/mailpit.tar.gz" "https://github.com/axllent/mailpit/releases/download/$MAILPIT_VERSION/mailpit-linux-amd64.tar.gz"
  echo "$MAILPIT_SHA256  $ROOT/.vendor/mailpit-dl/mailpit.tar.gz" | sha256sum -c --quiet - || { echo "Mailpit download does not match the pinned checksum"; exit 1; }
  tar -xzf "$ROOT/.vendor/mailpit-dl/mailpit.tar.gz" -C "$ROOT/.vendor/mailpit" mailpit
fi
# Stop leftovers of ours from an earlier run (only processes this script started).
m4_stop_old() { # pidfile pattern
  local pid; pid=$(cat "$LOG_DIR/$1.pid" 2>/dev/null || true)
  if [ -n "$pid" ] && [ -r "/proc/$pid/cmdline" ] && tr '\0' ' ' <"/proc/$pid/cmdline" | grep -q "$2"; then kill "$pid" 2>/dev/null || true; sleep 1; fi
  rm -f "$LOG_DIR/$1.pid"
}
m4_stop_old mailpit "mailpit --smtp"
m4_stop_old email-service "src/main.ts"
m4_started() { # name pid -> record it and make sure it is still running
  EXTRA_PIDS="$EXTRA_PIDS $2"; echo "$2" >"$LOG_DIR/$1.pid"
  sleep 1
  kill -0 "$2" 2>/dev/null || { echo "  $1 did not start; see $LOG_DIR/$1.log"; tail -5 "$LOG_DIR/$1.log"; exit 1; }
}
"$MAILPIT" --smtp 127.0.0.1:1025 --listen 127.0.0.1:8025 --disable-version-check >"$LOG_DIR/mailpit.log" 2>&1 &
m4_started mailpit $!
for _ in $(seq 1 20); do curl -s -m 1 "$MAILPIT_API/messages" >/dev/null 2>&1 && break; sleep 0.5; done
curl -s -X DELETE "$MAILPIT_API/messages" >/dev/null
check "M4: Mailpit is catching mail" "$(curl -s "$MAILPIT_API/messages" | json 'd.total')" "0"

# Same local-time trick as M3 (about 10:00 local, never near midnight).
M4_H=$(date -u +%-H)
M4_N=$((10 - M4_H)); [ "$M4_N" -gt 14 ] && M4_N=$((M4_N - 24)); [ "$M4_N" -lt -12 ] && M4_N=$((M4_N + 24))
if [ "$M4_N" -ge 0 ]; then M4_TZ="Etc/GMT-$M4_N"; else M4_TZ="Etc/GMT+$((-M4_N))"; fi

api PATCH /api/instance/settings/experimental '{"enableIsolatedWorkspaces":true}'
M4_REPO="$ROOT/.paperclip-data/it-repos/m4-$(date +%s)"
mkdir -p "$M4_REPO" && git -C "$M4_REPO" init -q -b main && echo hi >"$M4_REPO/README.md"
git -C "$M4_REPO" add README.md && git -C "$M4_REPO" -c user.email=t@example.com -c user.name=T commit -q -m init
api POST /api/companies "{\"name\":\"VT M4 $(date +%s)\"}"
M4_CID=$(echo "$API_BODY" | json 'd.id')
api POST "/api/companies/$M4_CID/projects" "{\"name\":\"demo\",\"executionWorkspacePolicy\":{\"enabled\":true,\"defaultMode\":\"isolated_workspace\",\"allowIssueOverride\":true,\"workspaceStrategy\":{\"type\":\"git_worktree\"}},\"workspace\":{\"name\":\"demo\",\"sourceType\":\"local_path\",\"cwd\":\"$M4_REPO\",\"isPrimary\":true}}"
M4_PID=$(echo "$API_BODY" | json 'd.id')
m4_agent() {
  api POST "/api/companies/$M4_CID/agents" "{\"name\":\"$1\",\"role\":\"engineer\",\"adapterType\":\"process\",\"adapterConfig\":{\"command\":\"pwd\"}}"
  local id; id=$(echo "$API_BODY" | json 'd.id')
  api PATCH "/api/agents/$id/permissions" '{"canCreateAgents":false,"canCreateSkills":false,"canAssignTasks":true}'
  echo "$id"
}
M4_A=$(m4_agent "Ana night agent"); M4_B=$(m4_agent "Bo night agent")

# Link signing key: a random value stored only as a Paperclip secret. The script
# keeps it in memory to build hostile test links; it is never printed.
M4_SIG=$(node -e "process.stdout.write(require('crypto').randomBytes(32).toString('hex'))")
api POST "/api/companies/$M4_CID/secrets" "{\"name\":\"vt-link-signing\",\"key\":\"vt-link-signing\",\"value\":\"$M4_SIG\"}"
check "M4: store the link signing key as a Paperclip secret" "$API_STATUS" "201"
M4_SID=$(echo "$API_BODY" | json 'd.id')

m4_config() { # nightStartHour for both
  api POST "/api/plugins/$PLUGIN_ID/config" "{\"companyId\":\"$M4_CID\",\"configJson\":{
    \"links\":{\"baseUrl\":\"$M4_LINKS\",\"signingSecret\":{\"type\":\"secret_ref\",\"secretId\":\"$M4_SID\"},\"expiresMinutes\":$M4_EXPIRES_MINUTES},
    \"night\":{\"projectId\":\"$M4_PID\"},\"checks\":{\"testCommand\":\"test -f README.md\"},\"people\":[
    {\"email\":\"ana@example.com\",\"agentId\":\"$M4_A\",\"timezone\":\"$M4_TZ\",\"nightStartHour\":$1,\"nightBudgetCapCents\":1000},
    {\"email\":\"bo@example.com\",\"agentId\":\"$M4_B\",\"timezone\":\"$M4_TZ\",\"nightStartHour\":$1,\"nightBudgetCapCents\":1000}]}}"
}
m4_config 11
check "M4: save settings with signed links" "$API_STATUS" "200"

(cd "$ROOT/email-service" && pnpm install --frozen-lockfile >/dev/null)
(cd "$ROOT/email-service" && PAPERCLIP_URL="$BASE" VT_COMPANY_ID="$M4_CID" LISTEN_PORT=3299 POLL_SECONDS=2 SMTP_PORT=1025 exec node src/main.ts) >"$LOG_DIR/email-service.log" 2>&1 &
m4_started email-service $!
for _ in $(seq 1 20); do curl -s -m 1 "$M4_LINKS/health" >/dev/null 2>&1 && break; sleep 0.5; done
check "M4: email service is up" "$(curl -s "$M4_LINKS/health")" "ok"

api GET "/api/plugins/$PLUGIN_ID/jobs"
M4_JOB=$(echo "$API_BODY" | json 'd.find(j=>j.jobKey==="night-tick").id')
m4_tick() {
  api POST "/api/plugins/$PLUGIN_ID/jobs/$M4_JOB/trigger" '{}'
  local run; run=$(echo "$API_BODY" | json 'd.runId')
  for _ in $(seq 1 30); do
    api GET "/api/plugins/$PLUGIN_ID/jobs/$M4_JOB/runs"
    case "$(echo "$API_BODY" | json "(d.find(r=>r.id==='$run')||{}).status")" in succeeded|failed) break ;; esac
    sleep 1
  done
}
m4_night() { api POST "/api/plugins/$PLUGIN_ID/data/night-status" "{\"companyId\":\"$M4_CID\",\"params\":{}}"; echo "$API_BODY" | json "(d.data.find(r=>r.owner==='$1')||{}).$2"; }
m4_issue() { api GET "/api/issues/$1"; echo "$API_BODY" | json "d.$2"; }
m4_event() { api POST "/api/plugins/$PLUGIN_ID/data/task-event" "{\"companyId\":\"$M4_CID\",\"params\":{\"taskId\":\"$1\"}}"; echo "$API_BODY" | json "d.data.$2"; }
m4_run_of() {
  local id=""
  for _ in $(seq 1 90); do
    api GET "/api/companies/$M4_CID/heartbeat-runs"
    id=$(echo "$API_BODY" | json "(Array.isArray(d)?d:d.items).filter(r=>r.agentId==='$1').map(r=>r.id)[0]")
    [ -n "$id" ] && break; sleep 1
  done
  echo "$id"
}
m4_tool() { # tool agentId params
  local run; run=$(m4_run_of "$2")
  api POST /api/plugins/tools/execute "{\"tool\":\"$PLUGIN_KEY:$1\",\"parameters\":$3,\"runContext\":{\"agentId\":\"$2\",\"runId\":\"$run\",\"companyId\":\"$M4_CID\",\"projectId\":\"$M4_PID\"}}"
}
m4_approve_plan() { # owner email
  local plan; plan=$(m4_night "$1" planIssueId)
  api GET "/api/issues/$plan/interactions"
  api POST "/api/issues/$plan/interactions/$(echo "$API_BODY" | json '(Array.isArray(d)?d:d.items).find(i=>i.kind==="request_confirmation").id')/accept" '{}'
}
m4_worktree() { # taskId -> worktree path once Paperclip made it
  local ew=""
  for _ in $(seq 1 45); do ew=$(m4_issue "$1" executionWorkspaceId); [ -n "$ew" ] && break; sleep 2; done
  api GET "/api/execution-workspaces/$ew"
  echo "$API_BODY" | json 'd.cwd'
}
m4_idle() { # wait until the agent has no queued or running run
  for _ in $(seq 1 60); do
    api GET "/api/companies/$M4_CID/heartbeat-runs"
    [ "$(echo "$API_BODY" | json "(Array.isArray(d)?d:d.items).filter(r=>r.agentId==='$1'&&['queued','running'].includes(r.status)).length")" = "0" ] && return
    sleep 1
  done
}
m4_work() { # taskId agentId file -> the "agent" commits a change and runs the checks gate
  local wt; wt=$(m4_worktree "$1")
  echo "change for $3" >"$wt/$3"
  git -C "$wt" add "$3" && git -C "$wt" -c user.email=agent@example.com -c user.name=Agent commit -q -m "Work on $3"
  m4_tool run_checks "$2" "{\"issueId\":\"$1\"}"
  echo "$wt"
}

echo "-- a night's work for Ana (3 tasks) and Bo (1 task)"
m4_tick
m4_tool propose_tonight "$M4_A" '{"tasks":[{"title":"Add greeting"},{"title":"Add farewell"},{"title":"Refactor everything"}]}'
[ -n "${IT_DEBUG:-}" ] && echo "    debug propose: $(echo "$API_BODY" | head -c 300) | night: $(m4_night ana@example.com status)"
M4_T1=$(echo "$API_BODY" | json 'd.result.data.taskIds[0]'); M4_T2=$(echo "$API_BODY" | json 'd.result.data.taskIds[1]'); M4_T3=$(echo "$API_BODY" | json 'd.result.data.taskIds[2]')
m4_tool propose_tonight "$M4_B" '{"tasks":[{"title":"Add a changelog"}]}'
M4_TB=$(echo "$API_BODY" | json 'd.result.data.taskIds[0]')
m4_approve_plan ana@example.com; m4_approve_plan bo@example.com
m4_tick
m4_config 10 && m4_tick # the night has started
M4_WT1=$(m4_work "$M4_T1" "$M4_A" greeting.txt | tail -1)
M4_WTB=$(m4_work "$M4_TB" "$M4_B" CHANGELOG.md | tail -1)
m4_idle "$M4_A"; m4_idle "$M4_B"
api PATCH "/api/issues/$M4_T1" '{"status":"done"}'; api PATCH "/api/issues/$M4_TB" '{"status":"done"}'
m4_tick
M4_WT2=$(m4_work "$M4_T2" "$M4_A" farewell.txt | tail -1)
m4_idle "$M4_A"
api PATCH "/api/issues/$M4_T2" '{"status":"done"}'
m4_tick
m4_worktree "$M4_T3" >/dev/null
m4_idle "$M4_A"
api PATCH "/api/issues/$M4_T3" '{"status":"cancelled"}' # the agent gives up on the refactor
m4_tick
check "Ana's night finished" "$(m4_night ana@example.com status)" "finished"
check "Bo's night finished" "$(m4_night bo@example.com status)" "finished"
check "nothing is merged during the night" "$(git -C "$M4_REPO" log --merges --oneline main | wc -l | tr -d ' ')" "0"

echo "-- morning briefing"
m4_config 1 && m4_tick # the night is over: morning
M4_SENT_AT=$(date +%s)
for _ in $(seq 1 30); do [ "$(curl -s "$MAILPIT_API/messages" | json 'd.total')" = "2" ] && break; sleep 1; done
check "one email per person arrives (caught by Mailpit)" "$(curl -s "$MAILPIT_API/messages" | json 'd.messages.map(m=>m.To[0].Address).sort().join(",")')" "ana@example.com,bo@example.com"
m4_mail() { # address -> plain text of their email
  local id; id=$(curl -s "$MAILPIT_API/messages" | json "d.messages.find(m=>m.To[0].Address==='$1').ID")
  curl -s "$MAILPIT_API/message/$id" | json 'd.Text' | tr -d '\r'
}
M4_MAIL_A=$(m4_mail ana@example.com); M4_MAIL_B=$(m4_mail bo@example.com)
check "subject counts Ready, Blocked and Failed" "$(curl -s "$MAILPIT_API/messages" | json 'd.messages.find(m=>m.To[0].Address==="ana@example.com").Subject')" "Your night of $(m4_night ana@example.com nightDate): 2 ready, 1 blocked, 0 failed"
check "email has Ready, Blocked and Failed sections" "$(echo "$M4_MAIL_A" | grep -cE '^(READY \(2\)|BLOCKED \(1\)|FAILED \(0\))$')" "3"
check "each task says what changed in one line" "$(echo "$M4_MAIL_A" | grep -c 'Add greeting: 1 file changed, 1 insertion(+)')" "1"
check "each task shows its checks result" "$(echo "$M4_MAIL_A" | grep -c 'checks passed on ')" "2"
check "blocked task says why" "$(echo "$M4_MAIL_A" | grep -c 'stopped by the night routine')" "1"
check "Approve links only for Ready tasks, Reject for every task" "$(echo "$M4_MAIL_A" | grep -c '^  Approve: ')/$(echo "$M4_MAIL_A" | grep -c '^  Reject: ')" "2/3"
m4_link() { echo "$1" | grep "^  $2: " | sed -n "${3}p" | sed "s/^  $2: //"; } # mail kind n
M4_APPROVE1=$(m4_link "$M4_MAIL_A" Approve 1); M4_APPROVE2=$(m4_link "$M4_MAIL_A" Approve 2)
M4_REJECT1=$(m4_link "$M4_MAIL_A" Reject 1); M4_REJECT3=$(m4_link "$M4_MAIL_A" Reject 3)
M4_APPROVE_B=$(m4_link "$M4_MAIL_B" Approve 1)
check "links point at the email service" "$(echo "$M4_APPROVE1" | grep -c "^$M4_LINKS/l/")" "1"

m4_merges() { git -C "$M4_REPO" log --merges --format=%P main | grep -c "$1" || true; } # branch head -> merges into main
m4_head() { git -C "$1" rev-parse HEAD; }
m4_post() { curl -s -w '\n%{http_code}' -X POST -H 'content-type: application/x-www-form-urlencoded' --data "${2:-}" "$1"; }

echo "-- Approve: opening the link changes nothing; a double click merges once"
M4_PAGE=$(curl -s "$M4_APPROVE1")
check "opening the Approve link shows a confirm button" "$(echo "$M4_PAGE" | grep -c '<button type="submit">Approve and merge</button>')" "1"
check "opening the link alone merges nothing" "$(m4_merges "$(m4_head "$M4_WT1")")" "0"
m4_post "$M4_APPROVE1" >"$LOG_DIR/m4-click1.out" & M4_P1=$!
m4_post "$M4_APPROVE1" >"$LOG_DIR/m4-click2.out" & M4_P2=$!
wait $M4_P1 $M4_P2
check "double click: exactly one merge into main" "$(m4_merges "$(m4_head "$M4_WT1")")" "1"
check "double click: one 'Merged' page and one 'Already done' page" "$(cat "$LOG_DIR/m4-click1.out" "$LOG_DIR/m4-click2.out" | grep -oE '<h1>(Merged|Already done)</h1>' | sort | tr '\n' ' ')" "<h1>Already done</h1> <h1>Merged</h1> "
check "a third click does nothing either" "$(m4_post "$M4_APPROVE1" | grep -oE '<h1>[^<]*</h1>')/$(m4_merges "$(m4_head "$M4_WT1")")" "<h1>Already done</h1>/1"
check "event log records accepted" "$(m4_event "$M4_T1" outcome)" "accepted"
check "ticket is closed as done" "$(m4_issue "$M4_T1" status)" "done"
check "the Reject link for an approved task does nothing" "$(m4_post "$M4_REJECT1" "reason=too+late" | grep -oE '<h1>[^<]*</h1>')/$(m4_event "$M4_T1" outcome)" "<h1>Not done</h1>/accepted"

echo "-- Approve refuses a branch that changed since the email"
echo "late change" >"$M4_WT2/late.txt"
git -C "$M4_WT2" add late.txt && git -C "$M4_WT2" -c user.email=agent@example.com -c user.name=Agent commit -q -m "late change"
M4_OUT=$(m4_post "$M4_APPROVE2")
check "changed branch: merge refused" "$(echo "$M4_OUT" | grep -oE '<h1>[^<]*</h1>')" "<h1>Not done</h1>"
check "changed branch: the page says why" "$(echo "$M4_OUT" | grep -c 'branch changed after the email')" "1"
check "changed branch: main does not contain it" "$(m4_merges "$(m4_head "$M4_WT2")")" "0"
check "changed branch: task stays undecided" "$(m4_event "$M4_T2" outcome)" ""

echo "-- Reject asks for a one-line reason and stores it"
M4_OUT=$(m4_post "$M4_REJECT3" "reason=")
check "reject without a reason asks for one (task stays as the night left it)" "$(echo "$M4_OUT" | grep -c 'one-line reason')/$(m4_event "$M4_T3" outcome)" "1/blocked"
check "reject page has a one-line reason box" "$(curl -s "$M4_REJECT3" | grep -c 'name="reason" maxlength="200"')" "1"
M4_OUT=$(m4_post "$M4_REJECT3" "reason=Too+risky+for+one+night")
check "reject with a reason" "$(echo "$M4_OUT" | grep -oE '<h1>[^<]*</h1>')" "<h1>Rejected</h1>"
check "event log stores the reason" "$(m4_event "$M4_T3" outcome)/$(m4_event "$M4_T3" reject_reason)" "rejected/Too risky for one night"
check "a second reject click does nothing" "$(m4_post "$M4_REJECT3" "reason=changed+my+mind" | grep -oE '<h1>[^<]*</h1>')/$(m4_event "$M4_T3" reject_reason)" "<h1>Already done</h1>/Too risky for one night"

echo "-- forged links and other people's links are refused"
M4_TOKEN_B=${M4_APPROVE_B##*/l/}
M4_FORGED="${M4_TOKEN_B%?}$( [ "${M4_TOKEN_B: -1}" = A ] && echo B || echo A )"
check "a forged signature is refused" "$(m4_post "$M4_LINKS/l/$M4_FORGED" | grep -oE '<h1>[^<]*</h1>')" "<h1>Link not usable</h1>"
# Build correctly signed links (with the real key) that try to cross people.
m4_sign() { M4_SIG="$M4_SIG" node -e "
  const c=require('crypto');const [tok,patch]=process.argv.slice(1);
  const claims={...JSON.parse(Buffer.from(tok.split('.')[0],'base64url')),...JSON.parse(patch)};
  const p=Buffer.from(JSON.stringify(claims)).toString('base64url');
  process.stdout.write(p+'.'+c.createHmac('sha256',process.env.M4_SIG).update(p).digest('base64url'))" "$1" "$2"; }
M4_TOKEN_A2=${M4_APPROVE2##*/l/}
M4_CROSS1=$(m4_sign "$M4_TOKEN_B" "{\"t\":\"$M4_T2\"}")            # Bo's link aimed at Ana's task
M4_CROSS2=$(m4_sign "$M4_TOKEN_A2" '{"o":"bo@example.com"}')       # Ana's task claimed by Bo
check "Bo's link cannot act on Ana's task, even when correctly signed" "$(m4_post "$M4_LINKS/l/$M4_CROSS1" | grep -oE '<h1>[^<]*</h1>')" "<h1>Link not usable</h1>"
check "Ana's task cannot be claimed by Bo" "$(m4_post "$M4_LINKS/l/$M4_CROSS2" | grep -oE '<h1>[^<]*</h1>')" "<h1>Link not usable</h1>"
check "nothing of Ana's was merged by those attempts" "$(m4_merges "$(m4_head "$M4_WT2")")" "0"

echo "-- expired links are refused"
M4_WAIT=$(( M4_SENT_AT + M4_EXPIRES_MINUTES * 60 + 5 - $(date +%s) ))
if [ "$M4_WAIT" -gt 0 ]; then echo "  waiting ${M4_WAIT}s for the ${M4_EXPIRES_MINUTES}-minute links to expire..."; sleep "$M4_WAIT"; fi
check "an expired Approve link is refused" "$(m4_post "$M4_APPROVE_B" | grep -oE '<h1>[^<]*</h1>')" "<h1>Link expired</h1>"
check "an expired link merged nothing" "$(m4_merges "$(m4_head "$M4_WTB")")" "0"
check "opening an expired link says so" "$(curl -s "$M4_APPROVE_B" | grep -c 'expired')" "1"
unset M4_SIG
