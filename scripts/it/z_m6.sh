# Milestone 6 (measurement): run flags, raw counts and the event-log CSV, checked against real
# Paperclip and real Postgres. The name sorts after v1f on purpose: it reads the data that m2, m3
# and the v1 scripts left behind (m2's checks and hand-offs, m3's budget stop, m4/v1e's five work
# orders and their conflict). IT_ONLY=z_m6 runs it alone (it then runs m2, m3 and v1f, and everything v1f needs, first).

if [ -z "${M2_CID:-}" ]; then . "$ROOT/scripts/it/m2.sh"; fi
if [ -z "${M3_CID:-}" ]; then . "$ROOT/scripts/it/m3.sh"; fi
if [ -z "${V1F_ROUTES:-}" ]; then . "$ROOT/scripts/it/v1f.sh"; fi
[ -n "${M4_CID:-}" ] && [ -n "${M3_CID:-}" ] && [ -n "${M2_CID:-}" ] || { fail "z_m6: needs the m2, m3 and m4 test beds"; return 0; }

# One company's counts, or its event log, the way the server's own command reads them.
z6_cli() { # companyId args... -> stdout of `vt-numbers`'s program
  local cid="$1"; shift
  (cd "$ROOT/email-service" && PAPERCLIP_URL="$BASE" VT_COMPANY_ID="$cid" node src/numbers.ts "$@") 2>"$LOG_DIR/z6-cli.err"
}
z6_counts() { curl -s "$V1F_ROUTES/counts?companyId=$1"; }

echo "-- raw counts (the counts route)"
Z6_N=$(z6_counts "$M4_CID")
echo "$Z6_N" >"$LOG_DIR/z6-counts.json"
check "z_m6: the migration ran and the counts route answers with whole numbers only" "$(echo "$Z6_N" | json 'Object.keys(d.team).sort().join(",")')/$(echo "$Z6_N" | json '[d.team,...d.people.flatMap(p=>[p.all,...p.kinds.map(k=>k.counts)])].every(c=>Object.values(c).every(Number.isInteger))')" "approved,budgetStops,checksFailed,failed,handedOver,notTested,ready,rejected,teammateOverlaps,timedOut,toolErrors,wouldBeConflicts/true"
check "z_m6: no percentage, rate or average in the counts" "$(echo "$Z6_N" | grep -ciE 'yield|percent|rate|average|median' || true)" "0"
check "z_m6: the people in the counts are the people with work" "$(echo "$Z6_N" | json 'd.people.map(p=>p.owner).join(",")')" "ana@example.com,bo@example.com"
check "z_m6: handed over, approved and rejected agree with v1f's numbers (5 handed over, 1 accepted, 1 rejected)" "$(echo "$Z6_N" | json '[d.team.handedOver,d.team.approved,d.team.rejected,d.team.failed].join("/")')" "5/1/1/0"
check "z_m6: per person: Ana handed over 4, Bo 1" "$(echo "$Z6_N" | json 'd.people.map(p=>p.owner.split("@")[0]+":"+p.all.handedOver).join(",")')" "ana:4,bo:1"
check "z_m6: the replay's conflict (release notes vs Bo's changelog) is one would-be conflict, one teammate overlap, for each of the two people" "$(echo "$Z6_N" | json '[d.team.wouldBeConflicts,d.team.teammateOverlaps].join("/")+" "+d.people.map(p=>p.all.wouldBeConflicts+"/"+p.all.teammateOverlaps).join(" ")')" "1/1 1/1 1/1"
check "z_m6: task kinds are listed under each person" "$(echo "$Z6_N" | json 'd.people.map(p=>p.owner.split("@")[0]+":"+p.kinds.map(k=>k.kind).join("+")).join(",")')" "ana:task,bo:task"

echo "-- the command: counts on the screen, the event log as CSV"
Z6_CSV="$LOG_DIR/z6-events.csv"; rm -f "$Z6_CSV"
z6_cli "$M4_CID" --events "$Z6_CSV" >"$LOG_DIR/z6-screen.txt"
check "z_m6: vt-numbers prints the counts, team first, with no percentage" "$(grep -c '^Team (everyone) ' "$LOG_DIR/z6-screen.txt")/$(grep -c '^ana@example.com ' "$LOG_DIR/z6-screen.txt")/$(grep -c '%' "$LOG_DIR/z6-screen.txt" || true)" "2/2/0"  # each line is in both tables
check "z_m6: the event-log file has the event-log columns, then the run flags" "$(head -1 "$Z6_CSV" | tr -d '\r')" "task id,owner,agent,task kind,proposed at,approved at,started at,finished at,checks result,outcome,reject reason,handed off to,run flags,flag details"
check "z_m6: the event-log file is readable by its owner only" "$(stat -c %a "$Z6_CSV")" "600"
check "z_m6: one row per task, and the decided ones say how they ended" "$(tail -n +2 "$Z6_CSV" | grep -c .)/$(grep -c ',accepted,' "$Z6_CSV")/$(grep -c ',rejected,' "$Z6_CSV")" "$(echo "$Z6_N" | json 'd.people.reduce((s,p)=>s+p.all.handedOver,0)')/1/1"
z6_cli "$M4_CID" --events - >"$LOG_DIR/z6-stdout.csv"
check "z_m6: --events - puts only the CSV on standard output" "$(head -1 "$LOG_DIR/z6-stdout.csv" | cut -c1-24)/$(grep -c 'Team (everyone)' "$LOG_DIR/z6-stdout.csv" || true)/$(grep -c 'Team (everyone)' "$LOG_DIR/z6-cli.err")" "task id,owner,agent,task/0/2"

echo "-- run flags"
Z6_M3="$LOG_DIR/z6-m3.csv"; z6_cli "$M3_CID" --events "$Z6_M3" >/dev/null
check "z_m6: the task the budget cap stopped carries a budget-stop flag (m3)" "$(grep "^$M3_T2," "$Z6_M3" | grep -c ',blocked,.*budget-stop,budget-stop: stopped: handover budget cap reached')" "1"
check "z_m6: a task that finished before the cap carries no flag (m3)" "$(grep "^$M3_T1," "$Z6_M3" | tr -d '\r' | awk -F, '{print $(NF-1)$NF}' | tr -d '"')" ""
Z6_M2="$LOG_DIR/z6-m2.csv"; z6_cli "$M2_CID" --events "$Z6_M2" >/dev/null
check "z_m6: a failed tool call on the agent's own ticket carries a tool-error flag (m2)" "$(grep "^$M2_ISS," "$Z6_M2" | grep -c 'tool-error')" "1"
check "z_m6: ...and its detail is that agent's own failed hand-off, not the refused call another agent made on it afterwards" "$(grep "^$M2_ISS," "$Z6_M2" | grep -c 'tool-error: [^|]*handoff_to_teammate: toEmail is not a configured teammate')/$(grep "^$M2_ISS," "$Z6_M2" | grep -c 'run_checks')" "1/0"
check "z_m6: a task whose checks ran with no test command carries a not-tested flag (m2)" "$(grep "^$M2_ISS," "$Z6_M2" | grep -c 'not-tested')" "1"
Z6_M2N=$(z6_counts "$M2_CID")
check "z_m6: the flags are counted too (m2: 1 tool error, 1 not tested)" "$(echo "$Z6_M2N" | json '[d.team.toolErrors,d.team.notTested].join("/")')" "1/1"
Z6_M3N=$(z6_counts "$M3_CID")
check "z_m6: ...and a budget stop (m3)" "$(echo "$Z6_M3N" | json 'd.team.budgetStops')" "1"
Z6_REJ=$(grep ',rejected,' "$Z6_CSV" | head -1)
check "z_m6: a rejected task carries a rejected flag with its reason (m4)" "$(echo "$Z6_REJ" | grep -c ',rejected,"\?rejected: ' || true)/$(echo "$Z6_REJ" | grep -c 'rejected;\?' || true)" "1/1"
