# Thin version 1, piece F: numbers from the event log, and the CSV export.
# Sourced by scripts/integration-test.sh after v1e (with IT_ONLY=v1f it runs m4
# and v1e first). Reads m4's company, where m4 and v1e left seven handed-over work
# orders: Ana's greeting (accepted), farewell (undecided), refactor (rejected),
# release notes and upgrade notes (undecided, conflicting with each other), tidy-up
# (undecided, blocked: it went outside its note) and Bo's changelog (undecided).
# In a full run it also reads v1d's company, where the pre-handover check moved two tasks.

if [ -z "${V1E_T:-}" ]; then . "$ROOT/scripts/it/v1e.sh"; fi
[ -n "${M4_CID:-}" ] || { fail "v1f: needs the m4 test bed"; return 0; }
V1F_ROUTES="$BASE/api/plugins/$PLUGIN_KEY/api"

curl -s "$V1F_ROUTES/numbers?companyId=$M4_CID" >"$LOG_DIR/v1f-numbers.json"
V1F_N=$(cat "$LOG_DIR/v1f-numbers.json")
check "v1f: work orders handed over, and what became of them" "$(echo "$V1F_N" | json '[d.team.workOrders,d.team.accepted,d.team.rejected,d.team.undecided].join("/")')" "7/1/1/5"
check "v1f: handover yield (accepted out of handed over)" "$(echo "$V1F_N" | json 'd.team.handoverYield')" "0.14"
check "v1f: conflicts found after (the merge replay)" "$(echo "$V1F_N" | json 'd.team.conflictsFoundAfter')" "1"
check "v1f: minutes to approve and decisions per handback are measured" "$(echo "$V1F_N" | json 'typeof d.team.minutesToApprove==="number" && d.team.decisionsPerHandback>0')" "true"
check "v1f: numbers per owner" "$(echo "$V1F_N" | json "d.owners.find(o=>o.owner==='$M4_ANA').workOrders+','+d.owners.find(o=>o.owner==='bo@example.com').workOrders")" "6,1"

# Paperclip sends plugin route bodies as JSON, so the CSV comes inside it; vt-numbers (on the
# server) runs email-service/src/numbers.ts, which writes the real file. Run that script here.
V1F_CSV_FILE="$LOG_DIR/v1f-numbers.csv"
rm -f "$V1F_CSV_FILE"
(cd "$ROOT/email-service" && PAPERCLIP_URL="$BASE" VT_COMPANY_ID="$M4_CID" node src/numbers.ts "$V1F_CSV_FILE") 2>"$LOG_DIR/v1f-numbers.out" >/dev/null
check "v1f: vt-numbers' script prints the team's measures" "$(grep -c '^Team: 7 work orders in .* handovers; yield 14% ' "$LOG_DIR/v1f-numbers.out")" "1"
V1F_CSV_OUT=$(tr -d '\r' <"$V1F_CSV_FILE" 2>/dev/null)
check "v1f: the CSV file has the measurement sheet's columns" "$(echo "$V1F_CSV_OUT" | head -1)" "Date,Handover,Owner,Work order,Task id,Check passed?,Outcome,Approved without edits?,Minutes to approve,Overlaps caught before,Conflicts found after"
check "v1f: one line per work order" "$(echo "$V1F_CSV_OUT" | tail -n +2 | grep -c .)" "7"
check "v1f: the accepted greeting reads as approved without edits" "$(echo "$V1F_CSV_OUT" | grep -c 'Add greeting,.*,yes,accepted,yes,')" "1"
check "v1f: the file is readable by its owner only" "$(stat -c %a "$V1F_CSV_FILE")" "600"
check "v1f: the route gives the same CSV" "$(curl -s "$V1F_ROUTES/numbers/csv?companyId=$M4_CID" | json 'd.csv' | tr -d '\r')" "$V1F_CSV_OUT"

if [ -n "${V1A_CID:-}" ] && [ -n "${V1D_DONE:-}" ]; then
  V1F_D=$(curl -s "$V1F_ROUTES/numbers?companyId=$V1A_CID")
  check "v1f: overlaps caught before (the pre-handover check in v1d)" "$(echo "$V1F_D" | json 'd.team.overlapsCaughtBefore+"/"+d.owners.find(o=>o.owner==="ana@example.com").overlapsCaughtBefore')" "2/2"
fi
