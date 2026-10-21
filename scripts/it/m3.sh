# Milestone 3 live checks. Sourced by scripts/integration-test.sh (uses its helpers).
# Evening proposal + one-tap approval, one night routine per person, night budget
# cap, per-step time-outs and retries. SLOW=1 also waits out a real time-out.

# Fixed-offset timezone in which it is about 10:00 now, so the test never crosses
# local midnight. Etc/GMT-N means UTC+N.
M3_H=$(date -u +%-H)
M3_N=$((10 - M3_H)); [ "$M3_N" -gt 14 ] && M3_N=$((M3_N - 24)); [ "$M3_N" -lt -12 ] && M3_N=$((M3_N + 24))
if [ "$M3_N" -ge 0 ]; then M3_TZ="Etc/GMT-$M3_N"; else M3_TZ="Etc/GMT+$((-M3_N))"; fi
M3_EVENING=11 # night starts at 11:00 local -> evening plan window now
M3_NIGHT=10   # night started at 10:00 local -> night now

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
M3_A=$(m3_agent "Ana night agent"); M3_B=$(m3_agent "Bo night agent"); M3_C=$(m3_agent "Cy night agent")

m3_config() { # nightStartHour for Ana, Bo, Cy
  api POST "/api/plugins/$PLUGIN_ID/config" "{\"companyId\":\"$M3_CID\",\"configJson\":{\"night\":{\"projectId\":\"$M3_PID\",\"stepTimeoutMinutes\":5,\"maxRetries\":1},\"people\":[
    {\"email\":\"ana@example.com\",\"agentId\":\"$M3_A\",\"timezone\":\"$M3_TZ\",\"nightStartHour\":$1,\"nightBudgetCapCents\":300,\"maxTasksPerNight\":2},
    {\"email\":\"bo@example.com\",\"agentId\":\"$M3_B\",\"timezone\":\"$M3_TZ\",\"nightStartHour\":$2,\"nightBudgetCapCents\":300},
    {\"email\":\"cy@example.com\",\"agentId\":\"$M3_C\",\"timezone\":\"$M3_TZ\",\"nightStartHour\":$3,\"nightBudgetCapCents\":300}]}}"
}
m3_config $M3_EVENING $M3_EVENING $M3_EVENING
check "M3: save settings (evening plan window for everyone)" "$API_STATUS" "200"

api GET "/api/plugins/$PLUGIN_ID/jobs"
M3_JOB=$(echo "$API_BODY" | json 'd.find(j=>j.jobKey==="night-tick").id')
m3_tick() { # trigger the night job and wait for its run to finish
  api POST "/api/plugins/$PLUGIN_ID/jobs/$M3_JOB/trigger" '{}'
  local run; run=$(echo "$API_BODY" | json 'd.runId')
  for _ in $(seq 1 30); do
    api GET "/api/plugins/$PLUGIN_ID/jobs/$M3_JOB/runs"
    M3_TICK=$(echo "$API_BODY" | json "(d.find(r=>r.id==='$run')||{}).status")
    case "$M3_TICK" in succeeded|failed) break ;; esac
    sleep 1
  done
}
m3_night() { # owner -> field of their newest night run
  api POST "/api/plugins/$PLUGIN_ID/data/night-status" "{\"companyId\":\"$M3_CID\",\"params\":{}}"
  echo "$API_BODY" | json "(d.data.find(r=>r.owner==='$1')||{}).$2"
}
m3_event() { api POST "/api/plugins/$PLUGIN_ID/data/task-event" "{\"companyId\":\"$M3_CID\",\"params\":{\"taskId\":\"$1\"}}"; echo "$API_BODY" | json "d.data.$2"; }
m3_issue() { api GET "/api/issues/$1"; echo "$API_BODY" | json "d.$2"; }
m3_run_of() { # wait until the agent has a run, print its newest run id
  local id=""
  for _ in $(seq 1 90); do
    api GET "/api/companies/$M3_CID/heartbeat-runs"
    id=$(echo "$API_BODY" | json "(Array.isArray(d)?d:d.items).filter(r=>r.agentId==='$1').map(r=>r.id)[0]")
    [ -n "$id" ] && break; sleep 1
  done
  echo "$id"
}
m3_propose() { # agentId runId tasksJson
  api POST /api/plugins/tools/execute "{\"tool\":\"$PLUGIN_KEY:propose_tonight\",\"parameters\":{\"tasks\":$3},\"runContext\":{\"agentId\":\"$1\",\"runId\":\"$2\",\"companyId\":\"$M3_CID\",\"projectId\":\"$M3_PID\"}}"
}

echo "-- evening proposal"
m3_tick
check "night job runs in Paperclip" "$M3_TICK" "succeeded"
check "Ana has an evening plan open" "$(m3_night ana@example.com status)" "proposing"
M3_PLAN=$(m3_night ana@example.com planIssueId)
check "plan ticket is assigned to Ana's agent" "$(m3_issue "$M3_PLAN" assigneeAgentId)" "$M3_A"
m3_tick
api GET "/api/companies/$M3_CID/issues"
check "still one plan per person after another tick" "$(echo "$API_BODY" | json "(Array.isArray(d)?d:d.items).filter(i=>i.originKind==='plugin:$PLUGIN_KEY:evening-plan'&&i.assigneeAgentId==='$M3_A').length")" "1"

M3_RUN_A=$(m3_run_of "$M3_A")
check "Paperclip woke Ana's agent for the plan ticket" "$([ -n "$M3_RUN_A" ] && echo yes || echo no)" "yes"
m3_propose "$M3_A" "$M3_RUN_A" '[{"title":"a"},{"title":"b"},{"title":"c"}]'
check "proposing more than the person's limit is refused" "$(echo "$API_BODY" | json 'd.result.error')" "propose at most 2 tasks"
m3_propose "$M3_A" "$M3_RUN_A" '[{"title":"Fix login","description":"Users see a 500"},{"title":"Write docs"}]'
M3_T1=$(echo "$API_BODY" | json 'd.result.data.taskIds[0]'); M3_T2=$(echo "$API_BODY" | json 'd.result.data.taskIds[1]')
check "agent proposes 2 tasks" "$([ -n "$M3_T1" ] && [ -n "$M3_T2" ] && echo yes || echo no)" "yes"
check "proposed tasks wait in backlog" "$(m3_issue "$M3_T1" status)" "backlog"
check "proposed tasks ask for their own worktree" "$(m3_issue "$M3_T1" executionWorkspaceSettings.workspaceStrategy.type)" "git_worktree"
check "plan waits for the owner" "$(m3_night ana@example.com status)" "awaiting_approval"
check "event log records proposed_at" "$([ -n "$(m3_event "$M3_T1" proposed_at)" ] && echo yes || echo no)" "yes"
api GET "/api/issues/$M3_PLAN/interactions"
M3_INT=$(echo "$API_BODY" | json '(Array.isArray(d)?d:d.items).find(i=>i.kind==="request_confirmation").id')
check "approval request is for humans only" "$(echo "$API_BODY" | json "(Array.isArray(d)?d:d.items).find(i=>i.id==='$M3_INT').resolverPolicy")" "human_only"

api POST "/api/agents/$M3_A/keys" '{"name":"vt-it-m3","scope":{"kind":"standard"}}'
M3_KEY=$(echo "$API_BODY" | json 'd.token')
M3_SELF=$(curl -s -w '\n%{http_code}' -H "Authorization: Bearer $M3_KEY" -H "X-Paperclip-Run-Id: $M3_RUN_A" -H 'content-type: application/json' -X POST "$BASE/api/issues/$M3_PLAN/interactions/$M3_INT/accept" -d '{}')
unset M3_KEY
echo "    (agent's attempt answered: ${M3_SELF##*$'\n'} $(echo "${M3_SELF%$'\n'*}" | json 'd.error'))"
check "agent cannot approve its own plan" "$([ "${M3_SELF##*$'\n'}" -ge 400 ] && echo refused || echo allowed)" "refused"
check "plan is still waiting after the agent's attempt" "$(m3_night ana@example.com status)" "awaiting_approval"

echo "-- one-tap approval and rejection"
api POST "/api/issues/$M3_PLAN/interactions/$M3_INT/accept" '{}'
check "owner taps approve" "$API_STATUS" "200"
m3_tick
check "plan is approved" "$(m3_night ana@example.com status)" "approved"
check "nothing starts before the night" "$(m3_issue "$M3_T1" status)" "backlog"

M3_RUN_B=$(m3_run_of "$M3_B")
m3_propose "$M3_B" "$M3_RUN_B" '[{"title":"Risky refactor"}]'
M3_TB=$(echo "$API_BODY" | json 'd.result.data.taskIds[0]')
M3_PLAN_B=$(m3_night bo@example.com planIssueId)
api GET "/api/issues/$M3_PLAN_B/interactions"
M3_INT_B=$(echo "$API_BODY" | json '(Array.isArray(d)?d:d.items).find(i=>i.kind==="request_confirmation").id')
api POST "/api/issues/$M3_PLAN_B/interactions/$M3_INT_B/reject" '{"reason":"not this week"}'
m3_tick
check "rejected plan is recorded" "$(m3_night bo@example.com status)" "rejected"
check "event log records the rejection and reason" "$(m3_event "$M3_TB" outcome)/$(m3_event "$M3_TB" reject_reason)" "rejected/not this week"

echo "-- night routine"
M3_RUN_C=$(m3_run_of "$M3_C")
m3_propose "$M3_C" "$M3_RUN_C" '[{"title":"Slow task"}]'
M3_TC=$(echo "$API_BODY" | json 'd.result.data.taskIds[0]')
M3_PLAN_C=$(m3_night cy@example.com planIssueId)
api GET "/api/issues/$M3_PLAN_C/interactions"
api POST "/api/issues/$M3_PLAN_C/interactions/$(echo "$API_BODY" | json '(Array.isArray(d)?d:d.items).find(i=>i.kind==="request_confirmation").id')/accept" '{}'
m3_tick

m3_config $M3_NIGHT $M3_EVENING $M3_NIGHT # Ana's and Cy's nights have started
m3_tick
check "Ana's night routine is running" "$(m3_night ana@example.com status)" "running"
check "first task is released to the agent" "$(m3_issue "$M3_T1" status | grep -Eq 'todo|in_progress' && echo yes || echo no)" "yes"
check "second task waits its turn" "$(m3_issue "$M3_T2" status)" "backlog"
check "event log records started_at" "$([ -n "$(m3_event "$M3_T1" started_at)" ] && echo yes || echo no)" "yes"
M3_EW=""
for _ in $(seq 1 30); do M3_EW=$(m3_issue "$M3_T1" executionWorkspaceId); [ -n "$M3_EW" ] && break; sleep 2; done
api GET "/api/execution-workspaces/$M3_EW"
check "the task got its own worktree and vt/ branch" "$(echo "$API_BODY" | json 'd.providerType')/$(echo "$API_BODY" | json 'd.branchName.split("/")[0]')" "git_worktree/vt"

api PATCH "/api/issues/$M3_T1" '{"status":"done"}'
m3_tick
check "next task starts when the first is done" "$(m3_issue "$M3_T2" status | grep -Eq 'todo|in_progress' && echo yes || echo no)" "yes"
check "event log records finished_at" "$([ -n "$(m3_event "$M3_T1" finished_at)" ] && echo yes || echo no)" "yes"

echo "-- night budget cap"
api POST "/api/companies/$M3_CID/cost-events" "{\"agentId\":\"$M3_A\",\"provider\":\"test\",\"model\":\"test\",\"costCents\":300,\"occurredAt\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\"}"
check "record 300 cents of spend for Ana's agent" "$API_STATUS" "201"
m3_tick
check "night stops at the budget cap" "$(m3_night ana@example.com status)" "budget_stopped"
check "running task is blocked" "$(m3_issue "$M3_T2" status)" "blocked"
check "event log records outcome blocked" "$(m3_event "$M3_T2" outcome)" "blocked"

echo "-- per-step time-out and retry"
check "Cy's task is running" "$(m3_night cy@example.com status)/$(m3_night cy@example.com currentAttempt)" "running/1"
if [ "${SLOW:-0}" = "1" ]; then
  echo "  waiting 5.5 minutes for the step time limit..."
  sleep 330
  m3_tick
  check "a step past its time limit is retried" "$(m3_night cy@example.com currentAttempt)" "2"
  check "retry releases the task to the agent again" "$(m3_issue "$M3_TC" status | grep -Eq 'todo|in_progress' && echo yes || echo no)" "yes"
else
  echo "  (skipped the 5-minute wait; run with SLOW=1 to check a real time-out)"
fi
