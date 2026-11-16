# Thin version 1, piece C: handover any time ("Hand over now") and the handover names.
# Sourced by scripts/integration-test.sh after v1a/v1b (it reuses v1a's company and
# isolated agents; with IT_ONLY=v1c it runs v1a and v1b first).
#
# Ana's scheduled handover is set 12 hours away from now, so whatever happens here
# comes from Hand over now. The board-only plugin routes are the ones the email
# service's page calls for the owner signed in to Paperclip (rehearsed in the
# deployment rehearsal over HTTPS).

if [ -z "${V1A_CID:-}" ]; then . "$ROOT/scripts/it/v1b.sh"; fi
[ -n "${V1A_CID:-}" ] || { fail "v1c: needs the v1a test bed"; return 0; }
V1C_ROUTES="$BASE/api/plugins/$PLUGIN_KEY/api"
v1c_route() { # METHOD path [body]
  local out
  if [ $# -ge 3 ]; then out=$(curl -s -w '\n%{http_code}' -H 'content-type: application/json' -X "$1" "$V1C_ROUTES$2" -d "$3"); else out=$(curl -s -w '\n%{http_code}' -X "$1" "$V1C_ROUTES$2"); fi
  API_STATUS="${out##*$'\n'}"; API_BODY="${out%$'\n'*}"
}
V1C_HOUR=$(( ($(date -u +%-H) + 12) % 24 ))

echo "-- settings saved under the old night-only names still work"
api GET "/api/plugins/$PLUGIN_ID/config?companyId=$V1A_CID"
V1C_CFG=$(echo "$API_BODY" | json "({...d.configJson,night:{projectId:'$V1A_PID'},people:d.configJson.people.map(p=>({...p,nightStartHour:$V1C_HOUR,timezone:'UTC'}))})")
api POST "/api/plugins/$PLUGIN_ID/config" "{\"companyId\":\"$V1A_CID\",\"configJson\":$V1C_CFG}"
v1a_audit
check "v1c: old names are accepted, and the audit names them" "$(echo "$API_BODY" | json "d.data.ok && d.data.legacyNames.includes('people[0].nightStartHour')")" "true"
V1C_NEW=$(node -e "import('$ROOT/plugin/src/config.ts').then(m=>process.stdout.write(JSON.stringify(m.migrateLegacySettings(JSON.parse(process.argv[1])).config)))" "$V1C_CFG")
api POST "/api/plugins/$PLUGIN_ID/config" "{\"companyId\":\"$V1A_CID\",\"configJson\":$V1C_NEW}"
v1a_audit
check "v1c: after the migration vt-setup does, no old names are left and the audit passes" "$(echo "$API_BODY" | json "d.data.ok && d.data.legacyNames.length")" "0"
check "v1c: the scheduled hour moved to the new name" "$(echo "$V1C_NEW" | json "d.people[0].handoverStartHour")" "$V1C_HOUR"

echo "-- Hand over now, far from the scheduled hour"
api GET "/api/plugins/$PLUGIN_ID/jobs"
V1C_JOB=$(echo "$API_BODY" | json 'd.find(j=>j.jobKey==="handover-tick").id')
v1c_tick() {
  api POST "/api/plugins/$PLUGIN_ID/jobs/$V1C_JOB/trigger" '{}'
  local run; run=$(echo "$API_BODY" | json 'd.runId')
  for _ in $(seq 1 30); do
    api GET "/api/plugins/$PLUGIN_ID/jobs/$V1C_JOB/runs"
    case "$(echo "$API_BODY" | json "(d.find(r=>r.id==='$run')||{}).status")" in succeeded | failed) break ;; esac
    sleep 1
  done
}
v1c_tick
v1c_route GET "/handovers/status?companyId=$V1A_CID&email=ana@example.com"
check "v1c: nothing is open before Ana taps (the schedule is 12 hours away)" "$(echo "$API_BODY" | json "d.handovers.filter(h=>['proposing','awaiting_approval','approved','running'].includes(h.status)).length")" "0"
v1c_route POST /handovers/start "{\"companyId\":\"$V1A_CID\",\"email\":\"ana@example.com\"}"
check "v1c: Hand over now starts a handover" "$API_STATUS/$(echo "$API_BODY" | json 'd.ok')" "201/true"
V1C_PLAN=$(echo "$API_BODY" | json 'd.planIssueId')
api GET "/api/issues/$V1C_PLAN"
check "v1c: its plan ticket opens at once, for Ana's agent" "$(echo "$API_BODY" | json "d.assigneeAgentId==='$V1A_A' && d.title.includes('handover now')")" "true"
v1c_route POST /handovers/start "{\"companyId\":\"$V1A_CID\",\"email\":\"ana@example.com\"}"
check "v1c: a second Hand over now is refused while one is open" "$API_STATUS/$(echo "$API_BODY" | json 'd.message')" "409/a handover is already in progress (proposing)"
v1c_route POST /handovers/start "{\"companyId\":\"$V1A_CID\",\"email\":\"eve@example.com\"}"
check "v1c: only people on the team can start one" "$API_STATUS" "404"

echo "-- the plan is proposed and approved; work starts right away"
api GET "/api/companies/$V1A_CID/heartbeat-runs"
V1C_RUN=$(echo "$API_BODY" | json "(Array.isArray(d)?d:d.items).filter(r=>r.agentId==='$V1A_A').map(r=>r.id)[0] || ''")
api POST /api/plugins/tools/execute "{\"tool\":\"$PLUGIN_KEY:propose_handover\",\"parameters\":{\"tasks\":[{\"title\":\"Add a greeting\",\"claims\":[\"greeting.txt\"]}]},\"runContext\":{\"agentId\":\"$V1A_A\",\"runId\":\"$V1C_RUN\",\"companyId\":\"$V1A_CID\",\"projectId\":\"$V1A_PID\"}}"
V1C_TASK=$(echo "$API_BODY" | json 'd.result.data.taskIds[0]')
check "v1c: the agent proposes through propose_handover" "$([ -n "$V1C_TASK" ] && echo yes || echo no)" "yes"
api GET "/api/issues/$V1C_PLAN/interactions"
V1C_INT=$(echo "$API_BODY" | json '(Array.isArray(d)?d:d.items)[0].id')
api POST "/api/issues/$V1C_PLAN/interactions/$V1C_INT/accept" '{}'
v1c_tick
v1c_tick
api GET "/api/issues/$V1C_TASK"
check "v1c: once approved, the task starts now, not at the scheduled hour" "$(echo "$API_BODY" | json 'd.status')" "todo"
v1c_route GET "/handovers/status?companyId=$V1A_CID&email=ana@example.com"
check "v1c: the status page data shows a running Hand over now" "$(echo "$API_BODY" | json 'd.handovers[0].kind+" "+d.handovers[0].status')" "now running"
api PATCH "/api/issues/$V1C_TASK" '{"status":"done"}'
v1c_tick
v1c_route GET "/handovers/status?companyId=$V1A_CID&email=ana@example.com"
check "v1c: when its tasks are done, the handover is finished" "$(echo "$API_BODY" | json 'd.handovers[0].status')" "finished"
