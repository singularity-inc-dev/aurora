# Milestone 2 live checks. Sourced by scripts/integration-test.sh (uses its helpers).
# Board-only hand-offs, one worktree + branch per task, checks gate on the ticket.

m2_wait_for_workspace() { # issueId -> prints execution workspace id (or nothing)
  local ew=""
  for _ in $(seq 1 45); do
    api GET "/api/issues/$1"
    ew=$(echo "$API_BODY" | json 'd.executionWorkspaceId || ""')
    [ -n "$ew" ] && break
    sleep 2
  done
  echo "$ew"
}
m2_latest_run() { # agentId -> latest heartbeat run id
  api GET "/api/companies/$M2_CID/heartbeat-runs"
  echo "$API_BODY" | json "(Array.isArray(d)?d:d.items).filter(r=>r.agentId==='$1').map(r=>r.id)[0] || ''"
}
m2_tool() { # tool params agentId runId -> sets API_STATUS/API_BODY
  api POST /api/plugins/tools/execute "{\"tool\":\"$PLUGIN_KEY:$1\",\"parameters\":$2,\"runContext\":{\"agentId\":\"$3\",\"runId\":\"$4\",\"companyId\":\"$M2_CID\",\"projectId\":\"$M2_PID\"}}"
}
m2_event() { # taskId -> event-log row JSON
  api POST "/api/plugins/$PLUGIN_ID/data/task-event" "{\"companyId\":\"$M2_CID\",\"params\":{\"taskId\":\"$1\"}}"
}

# Per-task worktrees are an experimental Paperclip setting (off by default).
api PATCH /api/instance/settings/experimental '{"enableIsolatedWorkspaces":true}'
check "M2: enable isolated workspaces (instance setting)" "$(echo "$API_BODY" | json 'd.enableIsolatedWorkspaces')" "true"

M2_REPO="$ROOT/.paperclip-data/it-repos/m2-$(date +%s)"
mkdir -p "$M2_REPO"
git -C "$M2_REPO" init -q -b main
git -C "$M2_REPO" -c user.email=t@example.com -c user.name=T commit -q --allow-empty -m init
echo "hello" >"$M2_REPO/README.md"
git -C "$M2_REPO" add README.md
git -C "$M2_REPO" -c user.email=t@example.com -c user.name=T commit -q -m readme

api POST /api/companies "{\"name\":\"VT M2 $(date +%s)\"}"
M2_CID=$(echo "$API_BODY" | json 'd.id')
api POST "/api/companies/$M2_CID/projects" "{\"name\":\"demo\",\"executionWorkspacePolicy\":{\"enabled\":true,\"defaultMode\":\"isolated_workspace\",\"allowIssueOverride\":true,\"workspaceStrategy\":{\"type\":\"git_worktree\"}},\"workspace\":{\"name\":\"demo\",\"sourceType\":\"local_path\",\"cwd\":\"$M2_REPO\",\"isPrimary\":true}}"
check "M2: create project on a local git repo" "$API_STATUS" "201"
M2_PID=$(echo "$API_BODY" | json 'd.id')
M2_AGENT='{"role":"engineer","adapterType":"process","adapterConfig":{"command":"pwd"}'
api POST "/api/companies/$M2_CID/agents" "${M2_AGENT},\"name\":\"Ana night agent\"}"
M2_A=$(echo "$API_BODY" | json 'd.id')
api POST "/api/companies/$M2_CID/agents" "${M2_AGENT},\"name\":\"Bo night agent\"}"
M2_B=$(echo "$API_BODY" | json 'd.id')

api POST "/api/plugins/$PLUGIN_ID/config" "{\"companyId\":\"$M2_CID\",\"configJson\":{\"checks\":{\"testCommand\":\"test -f README.md\",\"lintCommand\":\"true\",\"maxDiffLines\":50},\"people\":[{\"email\":\"ana@example.com\",\"agentId\":\"$M2_A\",\"timezone\":\"Europe/London\",\"nightStartHour\":22,\"nightBudgetCapCents\":500},{\"email\":\"bo@example.com\",\"agentId\":\"$M2_B\",\"timezone\":\"Europe/London\",\"nightStartHour\":22,\"nightBudgetCapCents\":500}]}}"
check "M2: save plugin settings" "$API_STATUS" "200"

echo "-- routes between agents"
api POST "/api/plugins/$PLUGIN_ID/data/route-audit" "{\"companyId\":\"$M2_CID\",\"params\":{}}"
check "route audit flags Paperclip's default agent permissions" "$(echo "$API_BODY" | json 'd.data.ok')" "false"
api POST "/api/agents/$M2_A/keys" '{"name":"vt-it","scope":{"kind":"standard"}}'
M2_KEY_A=$(echo "$API_BODY" | json 'd.token')
m2_as_a() { # METHOD PATH BODY, authenticated as agent A
  local out
  out=$(curl -s -w '\n%{http_code}' -H "Authorization: Bearer $M2_KEY_A" -H 'content-type: application/json' -X "$1" "$BASE$2" -d "$3")
  API_STATUS="${out##*$'\n'}"; API_BODY="${out%$'\n'*}"
}
m2_as_a POST "/api/agents/$M2_B/wakeup" '{"source":"on_demand","reason":"probe","forceFreshSession":false}'
check "agent cannot wake another agent directly (Paperclip)" "$API_STATUS" "403"
m2_as_a POST "/api/agents/$M2_B/heartbeat/invoke" '{}'
check "agent cannot invoke another agent's heartbeat (Paperclip)" "$API_STATUS" "403"
m2_as_a PATCH "/api/agents/$M2_A/permissions" '{"canCreateAgents":true,"canCreateSkills":true,"canAssignTasks":true}'
check "agent cannot change its own permissions (Paperclip)" "$API_STATUS" "403"
for agent in "$M2_A" "$M2_B"; do
  api PATCH "/api/agents/$agent/permissions" '{"canCreateAgents":false,"canCreateSkills":false,"canAssignTasks":true}'
done
api POST "/api/plugins/$PLUGIN_ID/data/route-audit" "{\"companyId\":\"$M2_CID\",\"params\":{}}"
check "route audit passes once the owner locks both agents" "$(echo "$API_BODY" | json 'd.data.ok')" "true"
m2_as_a POST "/api/companies/$M2_CID/agents" '{"name":"helper","role":"general"}'
check "locked agent cannot create a helper agent" "$API_STATUS" "403"

echo "-- one worktree and branch per task"
api POST "/api/companies/$M2_CID/issues" "{\"title\":\"Add a file\",\"projectId\":\"$M2_PID\",\"assigneeAgentId\":\"$M2_A\",\"status\":\"todo\",\"executionWorkspaceSettings\":{\"mode\":\"isolated_workspace\",\"workspaceStrategy\":{\"type\":\"git_worktree\",\"branchTemplate\":\"vt/{{issue.identifier}}-{{slug}}\"}}}"
M2_ISS=$(echo "$API_BODY" | json 'd.id')
M2_EW=$(m2_wait_for_workspace "$M2_ISS")
check "Paperclip created a workspace when the agent started" "$([ -n "$M2_EW" ] && echo yes || echo no)" "yes"
api GET "/api/execution-workspaces/$M2_EW"
M2_WT=$(echo "$API_BODY" | json 'd.cwd')
check "workspace is a git worktree" "$(echo "$API_BODY" | json 'd.providerType')" "git_worktree"
check "worktree has its own vt/ branch" "$(echo "$API_BODY" | json 'd.branchName.startsWith("vt/")')" "true"
check "worktree is not the shared checkout" "$([ "$M2_WT" != "$M2_REPO" ] && [ -d "$M2_WT" ] && echo yes || echo no)" "yes"
M2_RUN_A=$(m2_latest_run "$M2_A")

echo "-- checks gate"
echo "export const two = 2;" >"$M2_WT/two.ts"
m2_tool run_checks "{\"issueId\":\"$M2_ISS\"}" "$M2_A" "$M2_RUN_A"
check "checks pass on a small clean change" "$(echo "$API_BODY" | json 'd.result.data.passed')" "true"
api GET "/api/issues/$M2_ISS/documents/$(echo "$API_BODY" | json 'd.result.data.documentKey')"
check "report is attached to the ticket" "$(echo "$API_BODY" | json 'd.body.split("\n")[0]')" "# Checks gate: PASSED"
m2_event "$M2_ISS"
check "event log records checks passed" "$(echo "$API_BODY" | json 'd.data.checks_result')" "passed"

M2_FAKE=$(node -e "process.stdout.write(['gh','p_'].join('')+'A1b2C3d4'.repeat(5))")
echo "export const t = \"$M2_FAKE\";" >"$M2_WT/leak.ts"
m2_tool run_checks "{\"issueId\":\"$M2_ISS\"}" "$M2_A" "$M2_RUN_A"
check "checks fail on a leaked key" "$(echo "$API_BODY" | json 'd.result.data.results.find(r=>r.name==="secret-scan").status')" "failed"
api GET "/api/issues/$M2_ISS/documents/$(echo "$API_BODY" | json 'd.result.data.documentKey')"
check "report names the file but not the key" "$(echo "$API_BODY" | grep -c "$M2_FAKE" || true)/$(echo "$API_BODY" | grep -c 'leak.ts:1' || true)" "0/1"
rm -f "$M2_WT/leak.ts"
unset M2_FAKE
seq 1 80 >"$M2_WT/big.txt"
m2_tool run_checks "{\"issueId\":\"$M2_ISS\"}" "$M2_A" "$M2_RUN_A"
check "checks fail when the change is over the size limit" "$(echo "$API_BODY" | json 'd.result.data.results.find(r=>r.name==="diff-size").status')" "failed"
rm -f "$M2_WT/big.txt"
m2_event "$M2_ISS"
check "event log records checks failed" "$(echo "$API_BODY" | json 'd.data.checks_result')" "failed"

echo "-- hand-offs go through the board"
m2_tool handoff_to_teammate '{"toEmail":"bo@example.com","title":"Review two.ts","description":"Please review."}' "$M2_A" "$M2_RUN_A"
M2_H=$(echo "$API_BODY" | json 'd.result.data && d.result.data.issueId || ""')
check "hand-off creates a ticket" "$([ -n "$M2_H" ] && echo yes || echo no)" "yes"
api GET "/api/issues/$M2_H"
check "ticket is assigned to the teammate's agent" "$(echo "$API_BODY" | json "d.assigneeAgentId==='$M2_B'")" "true"
check "ticket is tagged as a Vision and Tom hand-off" "$(echo "$API_BODY" | json 'd.originKind')" "plugin:$PLUGIN_KEY:handoff"
check "ticket asks for its own worktree" "$(echo "$API_BODY" | json 'd.executionWorkspaceSettings.workspaceStrategy.type')" "git_worktree"
check "teammate's agent does not start before approval (backlog)" "$(echo "$API_BODY" | json 'd.status')" "backlog"
m2_event "$M2_H"
check "event log records who it was handed to" "$(echo "$API_BODY" | json 'd.data.handed_off_to')" "bo@example.com"

m2_tool handoff_to_teammate '{"toEmail":"eve@example.com","title":"x"}' "$M2_A" "$M2_RUN_A"
check "hand-off to a non-teammate is refused" "$(echo "$API_BODY" | json 'd.result.error')" "toEmail is not a configured teammate"
api POST "/api/agents/$M2_B/wakeup" '{"source":"on_demand","reason":"it","forceFreshSession":false}'
sleep 6
M2_RUN_B=$(m2_latest_run "$M2_B")
m2_tool run_checks "{\"issueId\":\"$M2_ISS\"}" "$M2_B" "$M2_RUN_B"
check "an agent cannot run checks on someone else's ticket" "$(echo "$API_BODY" | json 'd.result.error')" "you can only run checks on tickets assigned to you"
M2_SPOOF=$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $M2_KEY_A" -H 'content-type: application/json' -X POST "$BASE/api/plugins/tools/execute" \
  -d "{\"tool\":\"$PLUGIN_KEY:handoff_to_teammate\",\"parameters\":{\"toEmail\":\"ana@example.com\",\"title\":\"spoof\"},\"runContext\":{\"agentId\":\"$M2_B\",\"runId\":\"$M2_RUN_B\",\"companyId\":\"$M2_CID\",\"projectId\":\"$M2_PID\"}}")
check "an agent cannot call a tool pretending to be another agent (Paperclip)" "$M2_SPOOF" "403"
m2_tool handoff_to_teammate "{\"toEmail\":\"bo@example.com\",\"issueId\":\"$M2_ISS\",\"description\":\"Over to you.\"}" "$M2_A" "$M2_RUN_A"
api GET "/api/issues/$M2_ISS"
check "agent can hand off its own ticket by reassigning it" "$(echo "$API_BODY" | json "d.assigneeAgentId==='$M2_B'")" "true"
unset M2_KEY_A
