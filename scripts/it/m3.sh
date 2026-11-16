# Milestone 3 live checks. Sourced by scripts/integration-test.sh (uses its helpers).
# Agents here run as Paperclip's own user, so isolation is off ("isolation":{"required":false});
# the isolation itself is proven in scripts/it/v1a.sh.
# The owner's handover: the owner writes a note per ticket and taps Hand over (now, or
# for the scheduled time); the tap is the approval, so there is no plan to approve.
# Exactly the owner's tickets run; the agent cannot add, swap or suggest (Help me plan
# is off by default); per-task time and budget, the handover budget cap, time-outs and
# retries. SLOW=1 also waits out a real time-out.

# Fixed-offset timezone in which it is about 10:00 now, so the test never crosses
# local midnight. Etc/GMT-N means UTC+N.
M3_H=$(date -u +%-H)
M3_N=$((10 - M3_H)); [ "$M3_N" -gt 14 ] && M3_N=$((M3_N - 24)); [ "$M3_N" -lt -12 ] && M3_N=$((M3_N + 24))
if [ "$M3_N" -ge 0 ]; then M3_TZ="Etc/GMT-$M3_N"; else M3_TZ="Etc/GMT+$((-M3_N))"; fi
M3_LATER=11 # scheduled handover starts at 11:00 local -> not yet
M3_NOW=10   # scheduled handover started at 10:00 local -> its window is open

api PATCH /api/instance/settings/experimental '{"enableIsolatedWorkspaces":true}'
M3_REPO="$ROOT/.paperclip-data/it-repos/m3-$(date +%s)"
mkdir -p "$M3_REPO" && git -C "$M3_REPO" init -q -b main && echo hi >"$M3_REPO/README.md"
git -C "$M3_REPO" add README.md && git -C "$M3_REPO" -c user.email=t@example.com -c user.name=T commit -q -m init
api POST /api/companies "{\"name\":\"VT M3 $(date +%s)\"}"
M3_CID=$(echo "$API_BODY" | json 'd.id')
api POST "/api/companies/$M3_CID/projects" "{\"name\":\"demo\",\"executionWorkspacePolicy\":{\"enabled\":true,\"defaultMode\":\"isolated_workspace\",\"allowIssueOverride\":true,\"workspaceStrategy\":{\"type\":\"git_worktree\"}},\"workspace\":{\"name\":\"demo\",\"sourceType\":\"local_path\",\"cwd\":\"$M3_REPO\",\"isPrimary\":true}}"
M3_PID=$(echo "$API_BODY" | json 'd.id')
m3_agent() {
  api POST "/api/companies/$M3_CID/agents" "{\"name\":\"$1\",\"role\":\"engineer\",\"adapterType\":\"process\",\"adapterConfig\":{\"command\":\"pwd\"}}"
  local id; id=$(echo "$API_BODY" | json 'd.id')
  api PATCH "/api/agents/$id/permissions" '{"canCreateAgents":false,"canCreateSkills":false,"canAssignTasks":true}'
  echo "$id"
}
M3_A=$(m3_agent "Ana's agent"); M3_B=$(m3_agent "Bo's agent"); M3_C=$(m3_agent "Cy's agent")

m3_config() { # handover start hour for Ana, Bo, Cy; [Bo's helpMePlan]
  api POST "/api/plugins/$PLUGIN_ID/config" "{\"companyId\":\"$M3_CID\",\"configJson\":{\"serviceUserId\":\"$IT_SERVICE_USER\",\"isolation\":{\"required\":false},\"handover\":{\"projectId\":\"$M3_PID\",\"stepTimeoutMinutes\":5,\"maxRetries\":1},\"people\":[
    {\"email\":\"ana@example.com\",\"agentId\":\"$M3_A\",\"timezone\":\"$M3_TZ\",\"handoverStartHour\":$1,\"handoverBudgetCapCents\":300,\"maxTasksPerHandover\":2},
    {\"email\":\"bo@example.com\",\"agentId\":\"$M3_B\",\"timezone\":\"$M3_TZ\",\"handoverStartHour\":$2,\"handoverBudgetCapCents\":300,\"helpMePlan\":${4:-false}},
    {\"email\":\"cy@example.com\",\"agentId\":\"$M3_C\",\"timezone\":\"$M3_TZ\",\"handoverStartHour\":$3,\"handoverBudgetCapCents\":300}]}}"
}
m3_config $M3_LATER $M3_LATER $M3_LATER
check "M3: save settings (everyone's scheduled handover is later today)" "$API_STATUS" "200"

api GET "/api/plugins/$PLUGIN_ID/jobs"
M3_JOB=$(echo "$API_BODY" | json 'd.find(j=>j.jobKey==="handover-tick").id')
m3_tick() { # trigger the handover job and wait for its run to finish
  api POST "/api/plugins/$PLUGIN_ID/jobs/$M3_JOB/trigger" '{}'
  local run; run=$(echo "$API_BODY" | json 'd.runId')
  for _ in $(seq 1 30); do
    api GET "/api/plugins/$PLUGIN_ID/jobs/$M3_JOB/runs"
    M3_TICK=$(echo "$API_BODY" | json "(d.find(r=>r.id==='$run')||{}).status")
    case "$M3_TICK" in succeeded|failed) break ;; esac
    sleep 1
  done
}
m3_run() { # owner -> field of their newest handover run
  api POST "/api/plugins/$PLUGIN_ID/data/handover-status" "{\"companyId\":\"$M3_CID\",\"params\":{}}"
  echo "$API_BODY" | json "(d.data.find(r=>r.owner==='$1')||{}).$2"
}
m3_event() { api POST "/api/plugins/$PLUGIN_ID/data/task-event" "{\"companyId\":\"$M3_CID\",\"params\":{\"taskId\":\"$1\"}}"; echo "$API_BODY" | json "d.data.$2"; }
m3_issue() { api GET "/api/issues/$1"; echo "$API_BODY" | json "d.$2"; }
m3_heartbeat_of() { # wait until the agent has a run, print its newest run id
  local id=""
  for _ in $(seq 1 90); do
    api GET "/api/companies/$M3_CID/heartbeat-runs"
    id=$(echo "$API_BODY" | json "(Array.isArray(d)?d:d.items).filter(r=>r.agentId==='$1').map(r=>r.id)[0]")
    [ -n "$id" ] && break; sleep 1
  done
  echo "$id"
}
m3_tool() { # agentId runId tool params
  api POST /api/plugins/tools/execute "{\"tool\":\"$PLUGIN_KEY:$3\",\"parameters\":$4,\"runContext\":{\"agentId\":\"$1\",\"runId\":\"$2\",\"companyId\":\"$M3_CID\",\"projectId\":\"$M3_PID\"}}"
}
m3_plans() { api GET "/api/companies/$M3_CID/issues"; echo "$API_BODY" | json "(Array.isArray(d)?d:d.items).filter(i=>i.originKind==='plugin:$PLUGIN_KEY:handover-plan').length"; }

echo "-- nothing happens on the schedule unless the owner handed something over"
M3_T1=$(it_ticket "$M3_CID" "$M3_A" "$M3_PID" "Fix login"); M3_T2=$(it_ticket "$M3_CID" "$M3_A" "$M3_PID" "Write docs")
M3_EXTRA=$(it_ticket "$M3_CID" "$M3_A" "$M3_PID" "Something Ana did not choose")
m3_tick
check "the handover job runs in Paperclip" "$M3_TICK" "succeeded"
check "with nothing handed over, no handover and no plan ticket (agents do not propose)" "$(m3_run ana@example.com status)/$(m3_plans)" "/0"

echo "-- Ana hands over two tickets for her scheduled time, with a note on each"
it_handover "$M3_CID" ana@example.com scheduled "[{\"issueId\":\"$M3_T1\",\"what\":\"Fix the 500 on login\",\"doneWhen\":\"login works\",\"files\":\"src/login/\",\"maxMinutes\":\"30\",\"budgetCents\":\"200\"},$(it_note "$M3_T2" docs/)]"
check "Ana's tap is accepted, for her scheduled time" "$API_STATUS/$(echo "$API_BODY" | json 'd.when')" "201/scheduled"
it_handover "$M3_CID" ana@example.com now "[$(it_note "$M3_EXTRA" extra.txt),$(it_note "$M3_T1" x.txt),$(it_note "$M3_T2" y.txt)]"
check "more tickets than her limit are refused" "$API_STATUS/$(echo "$API_BODY" | json 'd.message')" "400/choose at most 2 ticket(s)"
it_handover "$M3_CID" ana@example.com now "[{\"issueId\":\"$M3_EXTRA\",\"what\":\"x\",\"doneWhen\":\"\",\"files\":\"x\"}]"
check "a note without 'done when' is refused" "$API_STATUS/$(echo "$API_BODY" | json 'd.message')" "400/ticket 1: write how you will know it is done (\"Done when\")"
api GET "/api/issues/$M3_T1/comments"
check "the agent's brief is on the ticket: what, done when, limits" "$(echo "$API_BODY" | json "(Array.isArray(d)?d:d.items).some(c=>c.body.includes('**What to do:** Fix the 500 on login')&&c.body.includes('**Done when:** login works')&&c.body.includes('Time: 30 minutes.')&&c.body.includes('Budget: 200 cents.'))")" "true"
check "no plan ticket, no approval request: the tap was the approval" "$(m3_plans)/$(api GET "/api/issues/$M3_T1/interactions" >/dev/null; echo "$API_BODY" | json '(Array.isArray(d)?d:d.items).length')" "0/0"
check "the event log records proposed and approved at the tap" "$([ -n "$(m3_event "$M3_T1" proposed_at)" ] && [ -n "$(m3_event "$M3_T1" approved_at)" ] && echo yes)" "yes"
m3_tick
check "before the scheduled time: approved, waiting, exactly Ana's two tickets" "$(m3_run ana@example.com status)/$(m3_run ana@example.com taskIds | json 'd.join()')" "approved/$M3_T1,$M3_T2"
check "nothing starts before the scheduled time" "$(m3_issue "$M3_T1" status)" "backlog"

echo "-- Bo takes back what he queued; Cy's handover will run long"
M3_TB=$(it_ticket "$M3_CID" "$M3_B" "$M3_PID" "Risky refactor")
it_handover "$M3_CID" bo@example.com scheduled "[$(it_note "$M3_TB" src/core/)]"
it_route POST /handovers/withdraw "{\"companyId\":\"$M3_CID\",\"email\":\"bo@example.com\"}"
check "Bo takes his queued ticket back before it starts" "$(echo "$API_BODY" | json 'd.withdrawn')" "1"
M3_TC=$(it_ticket "$M3_CID" "$M3_C" "$M3_PID" "Slow task")
it_handover "$M3_CID" cy@example.com scheduled "[$(it_note "$M3_TC" slow.txt)]"

echo "-- the scheduled handover runs exactly Ana's tickets"
m3_config $M3_NOW $M3_NOW $M3_NOW # everyone's scheduled handover has started
m3_tick
check "Ana's handover is running" "$(m3_run ana@example.com status)" "running"
check "her first ticket is released to the agent" "$(m3_issue "$M3_T1" status | grep -Eq 'todo|in_progress' && echo yes || echo no)" "yes"
check "the second waits its turn" "$(m3_issue "$M3_T2" status)" "backlog"
check "the ticket she did not choose is never touched" "$(m3_issue "$M3_EXTRA" status)" "backlog"
check "Bo's withdrawn ticket does not run" "$(m3_run bo@example.com status)/$(m3_issue "$M3_TB" status)" "/backlog"
check "the event log records started_at" "$([ -n "$(m3_event "$M3_T1" started_at)" ] && echo yes || echo no)" "yes"
M3_EW=""
for _ in $(seq 1 30); do M3_EW=$(m3_issue "$M3_T1" executionWorkspaceId); [ -n "$M3_EW" ] && break; sleep 2; done
api GET "/api/execution-workspaces/$M3_EW"
check "an owner-written ticket gets its own worktree and vt/ branch" "$(echo "$API_BODY" | json 'd.providerType')/$(echo "$API_BODY" | json 'd.branchName.split("/")[0]')" "git_worktree/vt"

echo "-- agents cannot add, swap or suggest work, and cannot hand over"
M3_KEY_RES=$(api POST "/api/agents/$M3_A/keys" '{"name":"vt-it-m3","scope":{"kind":"standard"}}'; echo "$API_BODY")
M3_KEY=$(echo "$M3_KEY_RES" | json 'd.token')
M3_AS_AGENT=$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $M3_KEY" -H 'content-type: application/json' -X POST "$IT_ROUTES/handovers/start" -d "{\"companyId\":\"$M3_CID\",\"email\":\"ana@example.com\",\"when\":\"now\",\"tasks\":[$(it_note "$M3_EXTRA" x.txt)]}")
unset M3_KEY
check "an agent cannot call the hand-over route" "$([ "$M3_AS_AGENT" -ge 400 ] && echo refused || echo "allowed ($M3_AS_AGENT)")" "refused"
M3_RUN_A=$(m3_heartbeat_of "$M3_A")
m3_tool "$M3_A" "$M3_RUN_A" propose_handover '{"tasks":[{"title":"My own idea","claims":["src/"]}]}'
check "the agent cannot suggest tasks (Help me plan is off by default)" "$(echo "$API_BODY" | json 'd.result.error')" "your owner chooses the work; Help me plan is off, so you cannot suggest tasks"
m3_tool "$M3_A" "$M3_RUN_A" handoff_to_teammate "{\"toEmail\":\"bo@example.com\",\"issueId\":\"$M3_T2\"}"
check "the agent cannot hand a ticket its owner handed over to someone else" "$(echo "$API_BODY" | json 'd.result.error')/$(m3_issue "$M3_T2" assigneeAgentId)" "your owner handed this ticket over to you; only your owner can change that/$M3_A"

echo "-- the task's own budget, then the handover's budget cap"
api POST "/api/companies/$M3_CID/cost-events" "{\"agentId\":\"$M3_A\",\"provider\":\"test\",\"model\":\"test\",\"costCents\":200,\"occurredAt\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\"}"
check "record 200 cents of spend on Ana's first task" "$API_STATUS" "201"
m3_tick
check "the task's own budget (200 cents) stops it" "$(m3_event "$M3_T1" outcome)/$(m3_issue "$M3_T1" status)" "blocked/blocked"
api GET "/api/issues/$M3_T1/comments"
check "...and the ticket says why" "$(echo "$API_BODY" | json "(Array.isArray(d)?d:d.items).some(c=>c.body==='The handover stopped this task: its budget of 200 cents was reached.')")" "true"
check "the next ticket starts" "$(m3_issue "$M3_T2" status | grep -Eq 'todo|in_progress' && echo yes || echo no)" "yes"
api POST "/api/companies/$M3_CID/cost-events" "{\"agentId\":\"$M3_A\",\"provider\":\"test\",\"model\":\"test\",\"costCents\":100,\"occurredAt\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\"}"
m3_tick
check "the handover stops at its budget cap (300 cents)" "$(m3_run ana@example.com status)" "budget_stopped"
check "the running task is blocked" "$(m3_issue "$M3_T2" status)" "blocked"
api GET "/api/agents/$M3_A"
check "the agent is paused at the budget cap" "$(echo "$API_BODY" | json 'd.status')" "paused"

echo "-- Help me plan: suggestions are drafts until the owner hands them over"
m3_config $M3_NOW $M3_NOW $M3_NOW true
it_route POST /handovers/suggest "{\"companyId\":\"$M3_CID\",\"email\":\"ana@example.com\"}"
check "Ana cannot ask for suggestions (off for her)" "$API_STATUS" "409"
it_route POST /handovers/suggest "{\"companyId\":\"$M3_CID\",\"email\":\"bo@example.com\"}"
check "Bo (Help me plan on) asks his agent for suggestions" "$API_STATUS/$(echo "$API_BODY" | json 'd.ok')" "201/true"
M3_RUN_B=$(m3_heartbeat_of "$M3_B")
m3_tool "$M3_B" "$M3_RUN_B" propose_handover '{"tasks":[{"title":"Speed up search","description":"Cache results","doneWhen":"under 200 ms","claims":["src/search/"]}]}'
M3_SUG=$(echo "$API_BODY" | json 'd.result.data.taskIds[0]')
check "the agent suggests a task" "$([ -n "$M3_SUG" ] && echo yes || echo no)" "yes"
m3_tick
check "the suggestion only waits in Backlog: no handover runs" "$(m3_issue "$M3_SUG" status)/$(m3_run bo@example.com status)" "backlog/"
it_route GET "/handovers/status?companyId=$M3_CID&email=bo@example.com"
check "Bo sees it on his page as a draft from his agent" "$(echo "$API_BODY" | json "d.tickets.find(t=>t.id==='$M3_SUG').draft.source+':'+d.tickets.find(t=>t.id==='$M3_SUG').draft.doneWhen")" "agent:under 200 ms"
it_handover "$M3_CID" bo@example.com now "[{\"issueId\":\"$M3_SUG\",\"what\":\"Cache search results for 60 s\",\"doneWhen\":\"p95 under 200 ms\",\"files\":\"src/search/\"}]"
check "only Bo's tap starts it, with Bo's own note" "$API_STATUS/$(m3_run bo@example.com kind)/$(m3_issue "$M3_SUG" status | grep -Eq 'todo|in_progress' && echo started)" "201/now/started"

echo "-- per-step time-out and retry"
check "Cy's task is running" "$(m3_run cy@example.com status)/$(m3_run cy@example.com currentAttempt)" "running/1"
if [ "${SLOW:-0}" = "1" ]; then
  echo "  waiting 5.5 minutes for the step time limit..."
  sleep 330
  m3_tick
  check "a step past its time limit is retried" "$(m3_run cy@example.com currentAttempt)" "2"
  check "retry releases the task to the agent again" "$(m3_issue "$M3_TC" status | grep -Eq 'todo|in_progress' && echo yes || echo no)" "yes"
else
  echo "  (skipped the 5-minute wait; run with SLOW=1 to check a real time-out)"
fi
