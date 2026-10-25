# Thin version 1, piece E: merge replay at handback.
# Sourced by scripts/integration-test.sh after m4 (it reuses m4's company, its
# repository, Mailpit and the email service; with IT_ONLY=v1e it runs m4 first).
#
# After m4, Bo's "Add a changelog" is ready, undecided and already in Bo's handback
# email. Now Ana hands over now; her agent claims notes.txt (so the pre-handover
# check lets it through) but also writes CHANGELOG.md, which Bo's branch adds too.
# The replay must find that conflict, tell both owners, and merge nothing.

if [ -z "${M4_CID:-}" ]; then . "$ROOT/scripts/it/m4.sh"; fi
[ -n "${M4_CID:-}" ] || { fail "v1e: needs the m4 test bed"; return 0; }
V1E_ROUTES="$BASE/api/plugins/$PLUGIN_KEY/api"
V1E_MAIN_BEFORE=$(git -C "$M4_REPO" rev-parse main)
curl -s -X DELETE "$MAILPIT_API/messages" >/dev/null

echo "-- Ana's agent changes a file Bo's ready branch also changes"
V1E_START=$(curl -s -w '\n%{http_code}' -H 'content-type: application/json' -X POST "$V1E_ROUTES/handovers/start" -d "{\"companyId\":\"$M4_CID\",\"email\":\"ana@example.com\"}")
check "v1e: Ana hands over now" "${V1E_START##*$'\n'}" "201"
m4_tool propose_handover "$M4_A" '{"tasks":[{"title":"Write release notes","claims":["notes.txt"]}]}'
V1E_T=$(echo "$API_BODY" | json 'd.result.data.taskIds[0] || ""')
check "v1e: the pre-handover check lets it through (it claimed notes.txt only)" "$([ -n "$V1E_T" ] && echo yes || echo no)" "yes"
m4_approve_plan ana@example.com
m4_tick; m4_tick
V1E_WT=$(m4_worktree "$V1E_T")
echo "release notes" >"$V1E_WT/notes.txt"
echo "Ana's changelog" >"$V1E_WT/CHANGELOG.md"
git -C "$V1E_WT" add notes.txt CHANGELOG.md && git -C "$V1E_WT" -c user.email=agent@example.com -c user.name=Agent commit -q -m "Release notes"
m4_tool run_checks "$M4_A" "{\"issueId\":\"$V1E_T\"}"
m4_idle "$M4_A"
api PATCH "/api/issues/$V1E_T" '{"status":"done"}'
m4_tick

echo "-- the handback emails"
for _ in $(seq 1 30); do [ "$(curl -s "$MAILPIT_API/messages" | json 'd.total')" = "2" ] && break; sleep 1; done
check "v1e: Ana's handback and a notice for Bo arrive" "$(curl -s "$MAILPIT_API/messages" | json 'd.messages.map(m=>m.To[0].Address).sort().join(",")')" "ana@example.com,bo@example.com"
V1E_SUBJ_A=$(curl -s "$MAILPIT_API/messages" | json 'd.messages.find(m=>m.To[0].Address==="ana@example.com").Subject')
V1E_SUBJ_B=$(curl -s "$MAILPIT_API/messages" | json 'd.messages.find(m=>m.To[0].Address==="bo@example.com").Subject')
V1E_MAIL_A=$(m4_mail ana@example.com); V1E_MAIL_B=$(m4_mail bo@example.com)
check "v1e: Ana's subject counts the conflict" "$(echo "$V1E_SUBJ_A" | grep -c ': 1 ready, 0 blocked, 0 failed, 1 conflict$')" "1"
check "v1e: Ana's email names Bo's task and the file" "$(echo "$V1E_MAIL_A" | grep -c "^- Your \"Write release notes\" .* and bo@example.com's \"Add a changelog\" .* both change CHANGELOG.md.$")" "1"
check "v1e: Bo is told too" "$V1E_SUBJ_B" "A teammate's new work conflicts with yours (1): 1 ready for your decision"
check "v1e: Bo's email names Ana's task" "$(echo "$V1E_MAIL_B" | grep -c "^- Your \"Add a changelog\" .* and ana@example.com's \"Write release notes\" .* both change CHANGELOG.md.$")" "1"
check "v1e: both still decide for themselves (Approve links are there)" "$(echo "$V1E_MAIL_A" | grep -c '^  Approve: ')/$(echo "$V1E_MAIL_B" | grep -c '^  Approve: ')" "1/1"
check "v1e: nothing was merged" "$(git -C "$M4_REPO" rev-parse main)" "$V1E_MAIN_BEFORE"
check "v1e: the worktrees were not touched" "$(git -C "$V1E_WT" status --porcelain | wc -l | tr -d ' ')/$(git -C "$M4_WTB" status --porcelain | wc -l | tr -d ' ')" "0/0"
