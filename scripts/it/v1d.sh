# Thin version 1, piece D: claims and the pre-handover check.
# Sourced by scripts/integration-test.sh after v1c (it reuses v1a's company, its
# isolated agents and its project, whose primary workspace is a real git repository;
# with IT_ONLY=v1d it runs v1a to v1c first).
#
# The repository gets a CODEOWNERS file: src/ui is Ana's (by email), src/api is Bo's
# (by GitHub login). Bo hands over a ticket on docs/ for his scheduled time; then Ana
# tries to hand over one task in her own area, one in Bo's area and one on Bo's held
# files. Nothing is handed over and nothing moves: the owner decides what to do next.

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

echo "-- every task of a hand-over must say which files it may change"
V1D_BO_TASK=$(it_ticket "$V1A_CID" "$V1A_B" "$V1A_PID" "Rewrite the docs")
it_handover "$V1A_CID" bo@example.com scheduled "[{\"issueId\":\"$V1D_BO_TASK\",\"what\":\"Rewrite\",\"doneWhen\":\"docs build\",\"files\":\"\"}]"
check "v1d: a task without files is refused" "$API_STATUS/$(echo "$API_BODY" | json 'd.message.startsWith("ticket 1: list the files or folders it may change")')" "400/true"
it_handover "$V1A_CID" bo@example.com scheduled "[$(it_note "$V1D_BO_TASK" docs/)]"
check "v1d: Bo hands over his docs/ ticket for his scheduled time" "$API_STATUS" "201"

echo "-- Ana's hand-over goes through the pre-handover check"
V1D_UI=$(it_ticket "$V1A_CID" "$V1A_A" "$V1A_PID" "Search box"); V1D_API=$(it_ticket "$V1A_CID" "$V1A_A" "$V1A_PID" "Search API")
V1D_TYPO=$(it_ticket "$V1A_CID" "$V1A_A" "$V1A_PID" "Fix a typo in the guide")
it_handover "$V1A_CID" ana@example.com now "[$(it_note "$V1D_UI" src/ui/search.tsx),$(it_note "$V1D_API" src/api/search.ts),$(it_note "$V1D_TYPO" docs/guide.md)]"
V1D_RES="$API_BODY"
check "v1d: nothing is handed over when a task reaches into Bo's files" "$API_STATUS/$(echo "$V1D_RES" | json 'd.ok')" "409/false"
check "v1d: it names Bo's area, by the committed CODEOWNERS line (not the uncommitted edit)" "$(echo "$V1D_RES" | json 'd.overlaps.some(o=>o.includes("\"Search API\": `src/api/search.ts` is in bo@example.com'"'"'s area (CODEOWNERS line 2)"))')" "true"
check "v1d: and the files Bo's task already holds" "$(echo "$V1D_RES" | json 'd.overlaps.some(o=>o.includes("overlaps `docs`, which bo@example.com'"'"'s task \"Rewrite the docs\" already holds"))')" "true"
check "v1d: nothing moved: every ticket is still Ana's, in Backlog" "$(for t in "$V1D_UI" "$V1D_API" "$V1D_TYPO"; do api GET "/api/issues/$t"; echo "$API_BODY" | json "d.assigneeAgentId==='$V1A_A'&&d.status==='backlog'"; echo; done | sort -u)" "true"
it_handover "$V1A_CID" ana@example.com now "[$(it_note "$V1D_UI" src/ui/search.tsx)]"
check "v1d: the task in Ana's own area is handed over on its own" "$API_STATUS/$(echo "$API_BODY" | json 'd.taskIds.length')" "201/1"
git -C "$V1A_REPO" checkout -q -- CODEOWNERS
V1D_DONE=1

echo "-- a GitHub team in CODEOWNERS is named in a warning (it matches nobody)"
printf '/src/ui/   ana@example.com\n/src/api/  @bo-v1d\n/infra/    @acme-v1d/ops\n' >"$V1A_REPO/CODEOWNERS"
git -C "$V1A_REPO" add CODEOWNERS && git -C "$V1A_REPO" -c user.email=t@example.com -c user.name=T commit -q -m "a team"
api POST "/api/plugins/$PLUGIN_ID/data/codeowners" "{\"companyId\":\"$V1A_CID\",\"params\":{}}"
check "v1d: the admin's CODEOWNERS view names the team and its line" "$(echo "$API_BODY" | json 'd.data.teams.map(t=>t.team+":"+t.lines.join()).join()')" "@acme-v1d/ops:3"
check "v1d: ...with the warning the owner sees when handing over" "$(echo "$API_BODY" | json 'd.data.notes[0].startsWith("WARNING: CODEOWNERS names GitHub team @acme-v1d/ops (line 3).")')" "true"
git -C "$V1A_REPO" reset -q --hard HEAD~1
