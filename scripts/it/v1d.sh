# Thin version 1, piece D: claims and the pre-handover check.
# Sourced by scripts/integration-test.sh after v1c (it reuses v1a's company, its
# isolated agents and its project, whose primary workspace is a real git repository;
# with IT_ONLY=v1d it runs v1a to v1c first).
#
# The repository gets a CODEOWNERS file: src/ui is Ana's (by email), src/api is Bo's
# (by GitHub login). Bo claims docs/ first; then Ana proposes one task in her own
# area, one in Bo's area and one on Bo's claimed files.

if [ -z "${V1C_HOUR:-}" ]; then . "$ROOT/scripts/it/v1c.sh"; fi
[ -n "${V1A_CID:-}" ] || { fail "v1d: needs the v1a test bed"; return 0; }

printf '/src/ui/   ana@example.com\n/src/api/  @bo-v1d\n' >"$V1A_REPO/CODEOWNERS"
git -C "$V1A_REPO" add CODEOWNERS && git -C "$V1A_REPO" -c user.email=t@example.com -c user.name=T commit -q -m "owner areas"
# An uncommitted change an agent might make: the check must ignore it.
printf '* @bo-v1d\n' >"$V1A_REPO/CODEOWNERS"

api GET "/api/plugins/$PLUGIN_ID/config?companyId=$V1A_CID"
V1D_CFG=$(echo "$API_BODY" | json "({...d.configJson,handover:{...(d.configJson.handover||{}),projectId:'$V1A_PID'},people:d.configJson.people.map(p=>p.email==='bo@example.com'?{...p,githubLogin:'bo-v1d'}:p)})")
api POST "/api/plugins/$PLUGIN_ID/config" "{\"companyId\":\"$V1A_CID\",\"configJson\":$V1D_CFG}"
check "v1d: settings with Bo's GitHub login are saved" "$API_STATUS" "200"

v1d_run() { # agentId -> newest heartbeat run id of that agent (waits for the plan's wake-up)
  local id=""
  for _ in $(seq 1 30); do
    api GET "/api/companies/$V1A_CID/heartbeat-runs"
    id=$(echo "$API_BODY" | json "(Array.isArray(d)?d:d.items).filter(r=>r.agentId==='$1').map(r=>r.id)[0] || ''")
    [ -n "$id" ] && break
    sleep 1
  done
  echo "$id"
}
v1d_propose() { # agentId tasksJson
  local run; run=$(v1d_run "$1")
  api POST /api/plugins/tools/execute "{\"tool\":\"$PLUGIN_KEY:propose_handover\",\"parameters\":{\"tasks\":$2},\"runContext\":{\"agentId\":\"$1\",\"runId\":\"$run\",\"companyId\":\"$V1A_CID\",\"projectId\":\"$V1A_PID\"}}"
}

echo "-- a task must say which files it may change"
v1c_route POST /handovers/start "{\"companyId\":\"$V1A_CID\",\"email\":\"bo@example.com\"}"
check "v1d: Bo starts a handover" "$API_STATUS" "201"
v1d_propose "$V1A_B" '[{"title":"Rewrite the docs"}]'
check "v1d: a task without claims is refused" "$(echo "$API_BODY" | json 'd.result.error.startsWith("task 1: list the files and folders it may change")')" "true"
v1d_propose "$V1A_B" '[{"title":"Rewrite the docs","claims":["docs/"]}]'
V1D_BO_TASK=$(echo "$API_BODY" | json 'd.result.data.taskIds[0] || ""')
check "v1d: Bo's task claiming docs/ is accepted" "$([ -n "$V1D_BO_TASK" ] && echo yes || echo no)" "yes"

echo "-- Ana's proposal goes through the pre-handover check"
v1c_route POST /handovers/start "{\"companyId\":\"$V1A_CID\",\"email\":\"ana@example.com\"}"
check "v1d: Ana starts a handover" "$API_STATUS $(echo "$API_BODY" | json "d.message || ''")" "201 "
V1D_PLAN=$(echo "$API_BODY" | json 'd.planIssueId')
v1d_propose "$V1A_A" '[{"title":"Search box","claims":["src/ui/search.tsx"]},{"title":"Search API","claims":["src/api/search.ts"]},{"title":"Fix a typo in the guide","claims":["docs/guide.md"]}]'
V1D_RES="$API_BODY"
check "v1d: only the task in Ana's own area stays in her plan" "$(echo "$V1D_RES" | json 'd.result.data.taskIds.length')" "1"
check "v1d: the other two go to Bo, who owns those files" "$(echo "$V1D_RES" | json 'd.result.data.moved.map(m=>m.title+">"+m.keeper).join("|")')" "Search API>bo@example.com|Fix a typo in the guide>bo@example.com"
check "v1d: the agent is told why" "$(echo "$V1D_RES" | json 'd.result.content.includes("reaches into bo@example.com'"'"'s files")')" "true"
V1D_AREA=$(echo "$V1D_RES" | json 'd.result.data.moved[0].ticketId')
api GET "/api/issues/$V1D_AREA"
check "v1d: the area task is a waiting ticket for Bo's agent" "$(echo "$API_BODY" | json "d.assigneeAgentId==='$V1A_B' && d.status==='backlog'")" "true"
check "v1d: it says which CODEOWNERS line (the committed one, not the agent's edit)" "$(echo "$API_BODY" | json 'd.description.includes("is in bo@example.com'"'"'s area (CODEOWNERS line 2)")')" "true"
api GET "/api/issues/$V1D_PLAN/interactions"
V1D_DETAILS=$(echo "$API_BODY" | json '(Array.isArray(d)?d:d.items)[0].payload.detailsMarkdown')
check "v1d: Ana's plan asks her two questions" "$(echo "$V1D_DETAILS" | grep -c '^[12]\. "')" "2"
check "v1d: and says what was overlapped" "$(echo "$V1D_DETAILS" | grep -c 'overlaps `docs`, claimed by bo@example.com'"'"'s task "Rewrite the docs"')" "1"
check "v1d: the kept task shows its claims" "$(echo "$V1D_DETAILS" | grep -c 'Search box (claims `src/ui/search.tsx`)')" "1"
git -C "$V1A_REPO" checkout -q -- CODEOWNERS
