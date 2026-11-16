# Thin version 1, piece E (merge replay at handback), and the limits of the owner's note.
# Sourced by scripts/integration-test.sh after m4 (it reuses m4's company, its
# repository, Mailpit and the email service; with IT_ONLY=v1e it runs m4 first).
#
# After m4, Bo's "Add a changelog" is ready and undecided, so it still holds
# CHANGELOG.md. Ana:
#  1. tries to hand over a task that may change CHANGELOG.md: refused, nothing changes;
#  2. hands over now three tasks: two that both may change notes.txt (her own work may
#     overlap), and one limited to tidy.txt whose agent also writes CHANGELOG.md.
# The replay must find the notes.txt conflict and merge nothing; the checks must block
# the task that went outside its note, so it gets no Approve link.

if [ -z "${M4_CID:-}" ]; then . "$ROOT/scripts/it/m4.sh"; fi
[ -n "${M4_CID:-}" ] || { fail "v1e: needs the m4 test bed"; return 0; }
V1E_MAIN_BEFORE=$(git -C "$M4_REPO" rev-parse main)
curl -s -X DELETE "$MAILPIT_API/messages" >/dev/null

echo "-- a hand-over that reaches into a teammate's held files is refused"
V1E_R1=$(it_ticket "$M4_CID" "$M4_A" "$M4_PID" "Write release notes"); V1E_R2=$(it_ticket "$M4_CID" "$M4_A" "$M4_PID" "Add upgrade notes")
V1E_R3=$(it_ticket "$M4_CID" "$M4_A" "$M4_PID" "Tidy up")
it_handover "$M4_CID" "$M4_ANA" now "[$(it_note "$V1E_R1" "notes.txt, CHANGELOG.md")]"
check "v1e: refused, naming Bo's task and file" "$API_STATUS/$(echo "$API_BODY" | json 'd.overlaps[0].includes("bo@example.com'"'"'s task \"Add a changelog\" already holds")')" "409/true"
check "v1e: ...and nothing was handed over" "$(m4_issue "$V1E_R1" status)/$(m4_night "$M4_ANA" kind)" "backlog/scheduled"

echo "-- Ana hands over now: two tasks on notes.txt, one limited to tidy.txt"
it_handover "$M4_CID" "$M4_ANA" now "[$(it_note "$V1E_R1" notes.txt),$(it_note "$V1E_R2" notes.txt),$(it_note "$V1E_R3" tidy.txt)]"
check "v1e: Ana hands over now" "$API_STATUS/$(echo "$API_BODY" | json 'd.taskIds.length')" "201/3"
v1e_do() { # taskId [file content]... : the "agent" commits these files, runs the checks, marks it done
  local t="$1"; shift
  m4_tick
  local wt; wt=$(m4_worktree "$t")
  # Without a worktree the rest would write into the current folder: stop here instead.
  [ -n "$wt" ] && [ -d "$wt" ] || { fail "v1e: task got its own worktree"; return 1; }
  while [ $# -ge 2 ]; do echo "$2" >"$wt/$1"; git -C "$wt" add "$1"; shift 2; done
  git -C "$wt" -c user.email=agent@example.com -c user.name=Agent commit -q -m "Work"
  m4_tool run_checks "$M4_A" "{\"issueId\":\"$t\"}"
  m4_idle "$M4_A"
  api PATCH "/api/issues/$t" '{"status":"done"}'
  echo "$wt"
}
V1E_WT1=$(v1e_do "$V1E_R1" notes.txt "Release notes" | tail -1)
V1E_WT2=$(v1e_do "$V1E_R2" notes.txt "Upgrade notes" | tail -1)
V1E_WT3=$(v1e_do "$V1E_R3" tidy.txt "tidy" CHANGELOG.md "Ana's changelog" | tail -1)
m4_event_checks() { m4_event "$1" checks_result; }
check "v1e: the task that wrote outside its note fails the checks" "$(m4_event_checks "$V1E_R3")" "failed"
m4_tool run_checks "$M4_A" "{\"issueId\":\"$V1E_R3\"}"
check "v1e: ...and the gate names the file" "$(echo "$API_BODY" | json "d.result.data.results.find(r=>r.name==='files').summary")" "1 file(s) outside the handover note: \`CHANGELOG.md\`"
m4_tick

echo "-- the handback email"
for _ in $(seq 1 30); do [ "$(curl -s "$MAILPIT_API/messages" | json 'd.total')" = "1" ] && break; sleep 1; done
check "v1e: Ana's handback arrives (Bo gets no notice: his work is not in conflict)" "$(curl -s "$MAILPIT_API/messages" | json 'd.messages.map(m=>m.To[0].Address).sort().join(",")')" "$M4_ANA"
V1E_SUBJ_A=$(curl -s "$MAILPIT_API/messages" | json "d.messages.find(m=>m.To[0].Address==='$M4_ANA').Subject")
V1E_MAIL_A=$(m4_mail "$M4_ANA")
echo "    (subject: $V1E_SUBJ_A)"
check "v1e: Ana's subject counts the conflict" "$(echo "$V1E_SUBJ_A" | grep -c ', 1 conflict$')" "1"
check "v1e: the email names both of her tasks and the file" "$(echo "$V1E_MAIL_A" | grep -c '^- Your "Write release notes" .* and your "Add upgrade notes" .* both change notes.txt.$')" "1"
check "v1e: the task outside its note is blocked, with the reason" "$(echo "$V1E_MAIL_A" | grep -A1 'Tidy up' | grep -c 'checks failed')" "1"
check "v1e: Approve links only for the two ready tasks" "$(echo "$V1E_MAIL_A" | grep -c '^  Approve: ')" "2"
check "v1e: nothing was merged" "$(git -C "$M4_REPO" rev-parse main)" "$V1E_MAIN_BEFORE"
check "v1e: the worktrees were not touched" "$(git -C "$V1E_WT1" status --porcelain | wc -l | tr -d ' ')/$(git -C "$M4_WTB" status --porcelain | wc -l | tr -d ' ')" "0/0"
# v1f reads these.
V1E_T="$V1E_R1"
