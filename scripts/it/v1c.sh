# Thin version 1, piece C: handover any time ("Hand over now") and the handover names.
# Sourced by scripts/integration-test.sh after v1a/v1b (it reuses v1a's company and
# isolated agents; with IT_ONLY=v1c it runs v1a and v1b first).
#
# Ana's scheduled handover is set 12 hours away from now, so whatever happens here
# comes from Hand over now: exactly the ticket Ana chose, with her note, at once (her
# tap is the approval). The board-only plugin routes are the ones the email service's
# page calls for the owner signed in to Paperclip (rehearsed over HTTPS in the
# deployment rehearsal).

if [ -z "${V1A_CID:-}" ]; then . "$ROOT/scripts/it/v1b.sh"; fi
[ -n "${V1A_CID:-}" ] || { fail "v1c: needs the v1a test bed"; return 0; }
v1c_route() { it_route "$@"; }
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
V1C_TASK=$(it_ticket "$V1A_CID" "$V1A_A" "$V1A_PID" "Add a greeting")
V1C_OTHER=$(it_ticket "$V1A_CID" "$V1A_A" "$V1A_PID" "Not chosen")
it_handover "$V1A_CID" ana@example.com now "[$(it_note "$V1C_TASK" greeting.txt)]"
check "v1c: Hand over now starts a handover" "$API_STATUS/$(echo "$API_BODY" | json 'd.ok')" "201/true"
api GET "/api/issues/$V1C_TASK"
check "v1c: the chosen ticket starts at once, not at the scheduled hour, with no plan to approve" "$(echo "$API_BODY" | json 'd.status' | grep -Eq 'todo|in_progress' && echo started)" "started"
api GET "/api/issues/$V1C_OTHER"
check "v1c: the ticket Ana did not choose stays in Backlog" "$(echo "$API_BODY" | json 'd.status')" "backlog"
it_handover "$V1A_CID" ana@example.com now "[$(it_note "$V1C_OTHER" x.txt)]"
check "v1c: a second Hand over now is refused while one is open" "$API_STATUS/$(echo "$API_BODY" | json 'd.message')" "409/a handover is already in progress (running)"
it_handover "$V1A_CID" eve@example.com now "[$(it_note "$V1C_OTHER" x.txt)]"
check "v1c: only people on the team can start one" "$API_STATUS" "404"
it_handover "$V1A_CID" bo@example.com now "[$(it_note "$V1C_OTHER" x.txt)]"
check "v1c: Bo cannot hand over Ana's ticket" "$API_STATUS/$(echo "$API_BODY" | json 'd.message')" "409/you can only hand over tickets assigned to your own agent"

echo "-- work runs exactly the note, and finishes"
v1c_tick
v1c_route GET "/handovers/status?companyId=$V1A_CID&email=ana@example.com"
check "v1c: the status page data shows a running Hand over now" "$(echo "$API_BODY" | json 'd.handovers[0].kind+" "+d.handovers[0].status')" "now running"
api PATCH "/api/issues/$V1C_TASK" '{"status":"done"}'
v1c_tick
v1c_route GET "/handovers/status?companyId=$V1A_CID&email=ana@example.com"
check "v1c: when its tasks are done, the handover is finished" "$(echo "$API_BODY" | json 'd.handovers[0].status')" "finished"
