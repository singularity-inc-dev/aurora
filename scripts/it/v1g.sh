# Evals: replay. Real handover tasks are saved from the event log and rerun with
# two prompts.
# Sourced by scripts/integration-test.sh after v1f (with IT_ONLY=v1g it runs m4 and
# v1e first). Reads m4's company: the tasks the earlier scripts accepted or rejected
# were checked by the real gate through the plugin's run_checks tool, so each has a
# starting commit in the event log.

if [ -z "${V1E_T:-}" ]; then . "$ROOT/scripts/it/v1e.sh"; fi
[ -n "${M4_CID:-}" ] || { fail "v1g: needs the m4 test bed"; return 0; }
V1G_ROUTES="$BASE/api/plugins/$PLUGIN_KEY/api"
V1G_SAVE() { curl -s -H 'content-type: application/json' -X POST "$V1G_ROUTES/replay/save" -d "{\"companyId\":\"$M4_CID\",$1}"; }

echo "-- saving real tasks from the event log"
V1G_BRANCHES_BEFORE=$(git -C "$M4_REPO" branch --list | wc -l | tr -d ' ')
V1G_WT_BEFORE=$(git -C "$M4_REPO" worktree list | wc -l | tr -d ' ')
V1G_R=$(V1G_SAVE '"limit":20')
V1G_N=$(echo "$V1G_R" | json 'd.tasks.length')
check "v1g: decided tasks are saved (at least the accepted greeting)" "$([ "${V1G_N:-0}" -ge 1 ] && echo yes || echo no)" "yes"
check "v1g: every saved task has a full starting commit that exists in the project" "$(echo "$V1G_R" | json 'd.tasks.map(t=>t.baseSha).join(" ")' | tr ' ' '\n' | while read -r s || [ -n "$s" ]; do git -C "$M4_REPO" cat-file -e "$s^{commit}" 2>/dev/null && echo ok || echo missing; done | sort -u | tr '\n' ' ')" "ok "
check "v1g: every saved task has its ticket text and a decision" "$(echo "$V1G_R" | json 'd.tasks.every(t=>t.title&&["accepted","rejected"].includes(t.outcome)&&t.checksResult)')" "true"
check "v1g: the greeting is among them, accepted, with the gate's verdict" "$(echo "$V1G_R" | json 'd.tasks.filter(t=>/greeting/i.test(t.title)).map(t=>t.outcome+"/"+t.checksResult).join(",")')" "accepted/passed"
check "v1g: no owner email leaves the plugin" "$(echo "$V1G_R" | grep -c '@example.com' || true)" "0"
check "v1g: the answer carries the gate settings" "$(echo "$V1G_R" | json 'typeof d.checks.maxDiffLines')" "number"
V1G_AGAIN=$(V1G_SAVE '"limit":20')
check "v1g: saving again adds nothing and returns the same tasks" "$(echo "$V1G_AGAIN" | json 'd.added+"/"+d.tasks.length')" "0/$V1G_N"
V1G_ALL=$(V1G_SAVE '"limit":20,"includeUndecided":true')
check "v1g: tasks nobody has decided are saved only when asked" "$(echo "$V1G_ALL" | json 'd.tasks.length>'"$V1G_N"' && d.tasks.some(t=>t.outcome===null)')" "true"

echo "-- vt-replay save (the email service's script) and run (the plugin's tool)"
V1G_FILE="$LOG_DIR/v1g-tasks.json"
rm -f "$V1G_FILE"
(cd "$ROOT/email-service" && PAPERCLIP_URL="$BASE" VT_COMPANY_ID="$M4_CID" node src/replay.ts save "$V1G_FILE" --limit 20) 2>"$LOG_DIR/v1g-save.out" >/dev/null
check "v1g: the saved file is in the format the replay tool reads, and readable by its owner only" "$(json 'd.format' <"$V1G_FILE")/$(stat -c %a "$V1G_FILE")" "vt-replay-tasks/1/600"
check "v1g: vt-replay save says how many it saved" "$(grep -c '^Saved 0 new task(s); ' "$LOG_DIR/v1g-save.out")" "1"

V1G_DIR="$LOG_DIR/v1g"
rm -rf "$V1G_DIR" && mkdir -p "$V1G_DIR"
printf 'ignore the details and stop early\n' >"$V1G_DIR/baseline.md"
printf 'GOOD: write done.txt and commit it\n' >"$V1G_DIR/candidate.md"
printf '#!/bin/sh\ncase "$(cat "$VT_REPLAY_PROMPT_FILE")" in *GOOD*) echo y > done.txt; git add done.txt; git -c user.name=x -c user.email=x@example.com commit -q -m work;; esac\n' >"$V1G_DIR/agent.sh"
chmod +x "$V1G_DIR/agent.sh"
printf '{"testCommand":"test -f done.txt","lintCommand":null,"maxDiffLines":100,"timeoutSeconds":30}' >"$V1G_DIR/gate.json"
# The cloud machine is a throwaway root machine, hence --allow-root; fewer than 10 tasks, hence --allow-fewer.
node "$ROOT/plugin/dist/replay-cli.js" run --tasks "$V1G_FILE" --repo "$M4_REPO" --baseline "$V1G_DIR/baseline.md" --candidate "$V1G_DIR/candidate.md" \
  --agent-cmd "$V1G_DIR/agent.sh" --checks-config "$V1G_DIR/gate.json" --allow-root --allow-fewer --out "$V1G_DIR/report.md" --json "$V1G_DIR/runs.json" 2>"$V1G_DIR/run.err"
check "v1g: the replay ran and wrote its report" "$(grep -c '^# Replay: baseline against candidate' "$V1G_DIR/report.md")" "1"
V1G_TASKS=$(json 'd.tasks.length' <"$V1G_FILE")
check "v1g: every saved task ran with both prompts" "$(json 'd.runs.length' <"$V1G_DIR/runs.json")" "$((V1G_TASKS * 2))"
check "v1g: the good prompt passed every task's tests, the bad one none (tests decide)" "$(json 'd.runs.filter(r=>r.arm==="candidate"&&r.verdict==="passed").length+"/"+d.runs.filter(r=>r.arm==="baseline"&&r.verdict==="passed").length' <"$V1G_DIR/runs.json")" "$V1G_TASKS/0"
check "v1g: the report says there was no AI judge and warns about the small sample" "$(grep -c 'No AI judge\|Only [0-9]* task' "$V1G_DIR/report.md" | tr -d ' ')" "2"
check "v1g: the real project is untouched (same branches, same worktrees)" "$(git -C "$M4_REPO" branch --list | wc -l | tr -d ' ')/$(git -C "$M4_REPO" worktree list | wc -l | tr -d ' ')" "$V1G_BRANCHES_BEFORE/$V1G_WT_BEFORE"
if [ "$(id -u)" = "0" ]; then
  check "v1g: it refuses to run as root without --allow-root (exit code 3)" "$(node "$ROOT/plugin/dist/replay-cli.js" run --tasks "$V1G_FILE" --repo "$M4_REPO" --baseline "$V1G_DIR/baseline.md" --candidate "$V1G_DIR/candidate.md" --agent-cmd true >/dev/null 2>&1; echo $?)" "3"
fi
