#!/usr/bin/env bash
# Integration test against a real, isolated Paperclip instance.
#
# Starts Paperclip (pinned version) with its own data folder and ports, installs
# the plugin from plugin/, then saves one valid and several invalid settings
# through the real HTTP API and checks what Paperclip does.
#
# Usage: scripts/integration-test.sh
#   KEEP_RUNNING=1  leave Paperclip running afterwards (prints the URL)
#   PORT=3199 PG_PORT=54399  override ports
#
# Never prints secret values. The only secret it creates is a random dummy.
set -euo pipefail

PAPERCLIP_VERSION="2026.1012.0"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PORT="${PORT:-3199}"
PG_PORT="${PG_PORT:-54399}"
DATA_DIR="$ROOT/.paperclip-data/it"
LOG_DIR="$ROOT/.test-logs"
BASE="http://127.0.0.1:$PORT"
PLUGIN_KEY="vision-and-tom.night-agents"

export PAPERCLIP_API_URL="$BASE"
export PAPERCLIP_TELEMETRY_DISABLED=1
export DO_NOT_TRACK=1

mkdir -p "$DATA_DIR" "$LOG_DIR"

if [ -s "$HOME/.nvm/nvm.sh" ]; then . "$HOME/.nvm/nvm.sh"; fi

# As root (cloud containers), embedded Postgres runs as the `postgres` user, which
# cannot read root's npm cache or a root-owned data folder. Keep both readable.
if [ "$(id -u)" = "0" ]; then
  export NPM_CONFIG_CACHE="$ROOT/.paperclip-data/npm-cache"
  mkdir -p "$NPM_CONFIG_CACHE"
  DB_DIR="$DATA_DIR/instances/default/db"
  if [ ! -d "$DB_DIR" ]; then
    mkdir -p "$DB_DIR"
    chown postgres:postgres "$DB_DIR"
    chmod 700 "$DB_DIR"
  fi
fi

PC=(npx -y "paperclipai@$PAPERCLIP_VERSION")

PASS=0
FAIL=0
pass() { PASS=$((PASS + 1)); echo "  PASS  $1"; }
fail() { FAIL=$((FAIL + 1)); echo "  FAIL  $1"; }
check() { if [ "$2" = "$3" ]; then pass "$1"; else fail "$1 (expected '$3', got '$2')"; fi; }

# json <expression> : evaluate a JS expression against stdin parsed as `d`.
# Prints nothing when the body is not JSON or the expression does not apply.
json() { node -e "let s='';process.stdin.on('data',c=>s+=c).on('end',()=>{let v;try{const d=JSON.parse(s);v=($1)}catch{v=undefined}process.stdout.write(v===undefined||v===null?'':typeof v==='string'?v:JSON.stringify(v))})"; }

# api METHOD PATH [BODY] : prints "<status> <body>"
api() {
  local out
  if [ $# -ge 3 ]; then
    out=$(curl -s -w '\n%{http_code}' -H 'content-type: application/json' -X "$1" "$BASE$2" -d "$3")
  else
    out=$(curl -s -w '\n%{http_code}' -X "$1" "$BASE$2")
  fi
  API_STATUS="${out##*$'\n'}"
  API_BODY="${out%$'\n'*}"
}

STARTED_PID=""
# Helper processes started by milestone checks (Mailpit, email service); always stopped.
EXTRA_PIDS=""
cleanup() {
  for pid in $EXTRA_PIDS; do kill "$pid" 2>/dev/null || true; done
  if [ -n "$STARTED_PID" ] && [ "${KEEP_RUNNING:-0}" != "1" ]; then
    kill -- "-$STARTED_PID" 2>/dev/null || kill "$STARTED_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT

CONFIG="$DATA_DIR/instances/default/config.json"

# wait_for_server PID LOG : wait until Paperclip logs that it is listening; prints the port.
wait_for_server() {
  for _ in $(seq 1 150); do
    local port
    port=$(sed -n 's/.*startup recovery complete on [0-9.]*:\([0-9]*\).*/\1/p' "$2" | tail -1)
    if [ -n "$port" ]; then echo "$port"; return 0; fi
    if ! kill -0 "$1" 2>/dev/null; then return 1; fi
    sleep 2
  done
  return 1
}
start_paperclip() { # args: paperclip subcommand...
  setsid "${PC[@]}" "$@" --data-dir "$DATA_DIR" >"$LOG_DIR/paperclip-it.log" 2>&1 &
  STARTED_PID=$!
  if ! wait_for_server "$STARTED_PID" "$LOG_DIR/paperclip-it.log" >/dev/null; then
    echo "  Paperclip did not start; last log lines:"; tail -20 "$LOG_DIR/paperclip-it.log"; exit 1
  fi
}
stop_paperclip() {
  kill -- "-$STARTED_PID" 2>/dev/null || true
  for _ in $(seq 1 30); do kill -0 "$STARTED_PID" 2>/dev/null || break; sleep 1; done
  STARTED_PID=""
}

echo "== 1. Start Paperclip $PAPERCLIP_VERSION on $BASE"
if curl -s -m 2 "$BASE/api/health" >/dev/null 2>&1; then
  echo "  already running on $BASE, reusing it"
else
  if [ ! -f "$CONFIG" ]; then
    # First start: quickstart defaults (trusted, loopback only). Onboarding picks its
    # own free ports, so stop it once and pin our ports in this instance's config.
    start_paperclip onboard --yes
    stop_paperclip
  fi
  node -e "
    const fs=require('fs'); const f=process.argv[1]; const c=JSON.parse(fs.readFileSync(f,'utf8'));
    c.server.port=Number(process.argv[2]); c.database.embeddedPostgresPort=Number(process.argv[3]);
    c.telemetry={...(c.telemetry||{}),enabled:false};
    fs.writeFileSync(f, JSON.stringify(c,null,2));" "$CONFIG" "$PORT" "$PG_PORT"
  start_paperclip run
fi
api GET /api/health
check "health endpoint answers" "$API_STATUS" "200"
check "server version is pinned" "$(echo "$API_BODY" | json 'd.version')" "$PAPERCLIP_VERSION"

echo "== 2. Build and install the plugin"
(cd "$ROOT/plugin" && pnpm install --frozen-lockfile >/dev/null && pnpm build >/dev/null)
WANT_VERSION=$(node -p "require('$ROOT/plugin/package.json').version")
HAVE=$("${PC[@]}" plugin list 2>/dev/null | grep "key=$PLUGIN_KEY" || true)
if [ -n "$HAVE" ] && ! echo "$HAVE" | grep -q "version=$WANT_VERSION "; then
  # Paperclip refuses upgrades that add capabilities; reinstalling re-grants them.
  # Uninstall without --force keeps the plugin's settings.
  echo "  installed version differs from $WANT_VERSION: reinstalling"
  "${PC[@]}" plugin uninstall "$PLUGIN_KEY" >"$LOG_DIR/plugin-uninstall.log" 2>&1
  HAVE=""
fi
if [ -n "$HAVE" ]; then
  echo "  already installed"
else
  "${PC[@]}" plugin install "$ROOT/plugin" >"$LOG_DIR/plugin-install.log" 2>&1 || { cat "$LOG_DIR/plugin-install.log"; exit 1; }
fi
# Paperclip's file watcher can lose track of a reinstalled plugin; a disable/enable
# cycle guarantees the worker runs the code that was just built.
"${PC[@]}" plugin disable "$PLUGIN_KEY" >/dev/null 2>&1 || true
"${PC[@]}" plugin enable "$PLUGIN_KEY" >/dev/null 2>&1
LIST=$("${PC[@]}" plugin list 2>/dev/null | grep "key=$PLUGIN_KEY" || true)
check "plugin is listed as ready" "$(echo "$LIST" | grep -o 'status=[a-z_]*')" "status=ready"
PLUGIN_ID=$(echo "$LIST" | sed -n 's/.*id=\([0-9a-f-]*\).*/\1/p')

echo "== 3. Create a test company, a dummy secret and two agents"
api POST /api/companies "{\"name\":\"VT integration $(date +%s)\"}"
check "create company" "$API_STATUS" "201"
CID=$(echo "$API_BODY" | json 'd.id')
DUMMY_VALUE=$(node -e "process.stdout.write(require('crypto').randomBytes(16).toString('hex'))")
api POST "/api/companies/$CID/secrets" "{\"name\":\"vt-dummy\",\"key\":\"vt-dummy\",\"value\":\"$DUMMY_VALUE\"}"
unset DUMMY_VALUE
check "create dummy secret" "$API_STATUS" "201"
SID=$(echo "$API_BODY" | json 'd.id')
api POST "/api/companies/$CID/agents" '{"name":"Ana night agent","role":"engineer"}'
check "create agent A" "$API_STATUS" "201"
AID_A=$(echo "$API_BODY" | json 'd.id')
api POST "/api/companies/$CID/agents" '{"name":"Bo night agent","role":"engineer"}'
check "create agent B" "$API_STATUS" "201"
AID_B=$(echo "$API_BODY" | json 'd.id')

person() { # email agentId [hour]
  echo "{\"email\":\"$1\",\"agentId\":\"$2\",\"timezone\":\"Europe/London\",\"nightStartHour\":${3:-22},\"nightBudgetCapCents\":500,\"secrets\":[{\"name\":\"github\",\"secret\":{\"type\":\"secret_ref\",\"secretId\":\"$SID\"}}]}"
}
VALID="{\"people\":[$(person ana@example.com "$AID_A"),$(person bo@example.com "$AID_B")]}"
DUP_AGENT="{\"people\":[$(person ana@example.com "$AID_A"),$(person bo@example.com "$AID_A")]}"
BAD_HOUR="{\"people\":[$(person ana@example.com "$AID_A" 24)]}"
RAW_SECRET="{\"people\":[{\"email\":\"ana@example.com\",\"agentId\":\"$AID_A\",\"timezone\":\"Europe/London\",\"nightStartHour\":22,\"nightBudgetCapCents\":500,\"secrets\":[{\"name\":\"gh\",\"secret\":\"not-a-ref\"}]}]}"
body() { echo "{\"companyId\":\"$CID\",\"configJson\":$1}"; }
people() { api POST "/api/plugins/$PLUGIN_ID/data/people" "{\"companyId\":\"$CID\",\"params\":{}}"; }

echo "== 4. Valid settings"
api POST "/api/plugins/$PLUGIN_ID/config/test" "$(body "$VALID")"
check "Test Connection says valid" "$(echo "$API_BODY" | json 'd.valid')" "true"
api POST "/api/plugins/$PLUGIN_ID/config" "$(body "$VALID")"
check "save valid settings" "$API_STATUS" "200"
people
check "worker reads saved settings" "$(echo "$API_BODY" | json 'd.data.ok')" "true"
check "worker sees 2 people" "$(echo "$API_BODY" | json 'd.data.people.length')" "2"
check "default max tasks per night is 3" "$(echo "$API_BODY" | json 'd.data.people[0].maxTasksPerNight')" "3"
check "secret ids are not exposed" "$(echo "$API_BODY" | grep -c "$SID" || true)" "0"

echo "== 5. Invalid settings that break the JSON schema are refused on save"
api POST "/api/plugins/$PLUGIN_ID/config" "$(body "$BAD_HOUR")"
check "night start hour 24 refused" "$API_STATUS" "400"
api POST "/api/plugins/$PLUGIN_ID/config" "$(body "$RAW_SECRET")"
check "raw (non-reference) secret refused" "$API_STATUS" "400"

echo "== 6. Invalid settings that only the plugin can detect (two people, one agent)"
api POST "/api/plugins/$PLUGIN_ID/config/test" "$(body "$DUP_AGENT")"
check "Test Connection says invalid" "$(echo "$API_BODY" | json 'd.valid')" "false"
check "Test Connection names the problem" "$(echo "$API_BODY" | json 'd.message')" "people[1].agentId: already bound to another person"
api POST "/api/plugins/$PLUGIN_ID/config" "$(body "$DUP_AGENT")"
check "Paperclip still saves it (known host behaviour)" "$API_STATUS" "200"
people
check "worker fails closed on invalid settings" "$(echo "$API_BODY" | json 'd.data.ok')" "false"

echo "== 7. Restore valid settings"
api POST "/api/plugins/$PLUGIN_ID/config" "$(body "$VALID")"
check "restore valid settings" "$API_STATUS" "200"

# Later milestones append their live checks here (see scripts/it/*.sh).
for extra in "$ROOT"/scripts/it/*.sh; do
  [ -e "$extra" ] || continue
  # IT_ONLY=m4 runs just that milestone's live checks (after the basic ones).
  if [ -n "${IT_ONLY:-}" ] && [ "$(basename "$extra" .sh)" != "$IT_ONLY" ]; then continue; fi
  echo "== $(basename "$extra")"
  # shellcheck source=/dev/null
  . "$extra"
done

echo
echo "Result: $PASS passed, $FAIL failed"
if [ "${KEEP_RUNNING:-0}" = "1" ]; then echo "Paperclip left running at $BASE (company $CID)"; fi
[ "$FAIL" -eq 0 ]
