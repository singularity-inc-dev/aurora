#!/usr/bin/env bash
# Deployment rehearsal: runs the real deployment kit (deploy/) on this machine,
# inside a folder (VT_ROOT) instead of the real system, and checks the result.
#
#  - PostgreSQL 16 (Ubuntu's binaries, a private cluster) as the database
#  - deploy/install.sh: Node and Caddy downloads checked against pinned checksums,
#    Paperclip from its lockfile, plugin and email service built, settings written
#  - Paperclip in authenticated mode, reachable only through Caddy (HTTPS with a
#    local certificate authority instead of Let's Encrypt; ports 8080/8443)
#  - deploy/bin/vt-setup: owner account + admin claim, company, plugin, settings
#  - invite links over HTTPS: a new person joins; used/expired/forged links refused
#  - vt-backup, a simulated disaster, vt-restore, and a simulated reboot
# Services are started the way their systemd unit files say (scripts/rehearsal/unit.mjs);
# this machine has no systemd, so a real reboot is not tested.
#
# Usage: scripts/deploy-rehearsal.sh      (about 10 minutes the first time)
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
R="$ROOT/.paperclip-data/rehearsal"
LOGS="$ROOT/.test-logs/rehearsal"
export VT_ROOT="$R/root" VT_REHEARSAL=1
export PG_HOST="$R/pgsock" PG_PORT=54516
export NPM_CONFIG_CACHE="$ROOT/.paperclip-data/npm-cache"
export PAPERCLIP_TELEMETRY_DISABLED=1 DO_NOT_TRACK=1
unset GITHUB_TOKEN || true
if [ -s "$HOME/.nvm/nvm.sh" ]; then . "$HOME/.nvm/nvm.sh" >/dev/null; fi

PASS=0; FAIL=0
pass() { PASS=$((PASS + 1)); echo "  PASS  $1"; }
fail() { FAIL=$((FAIL + 1)); echo "  FAIL  $1"; }
check() { if [ "$2" = "$3" ]; then pass "$1"; else fail "$1 (expected '$3', got '$2')"; fi; }
json() { node -e "let s='';process.stdin.on('data',c=>s+=c).on('end',()=>{let v;try{const d=JSON.parse(s);v=($1)}catch{v=undefined}process.stdout.write(v===undefined||v===null?'':typeof v==='string'?v:JSON.stringify(v))})"; }
rand() { node -e "process.stdout.write(require('crypto').randomBytes(${1:-16}).toString('hex'))"; }

DOMAIN=team.localhost
URL="https://$DOMAIN:8443"
PC="http://127.0.0.1:3398"
MP_API="http://127.0.0.1:8028/api/v1"
GH="http://127.0.0.1:3396"
KIT_BIN="$VT_ROOT/opt/vision-and-tom/app/deploy/bin"
UNITS="$VT_ROOT/etc/systemd/system"
STATE="$R/services"
SECRETS="$VT_ROOT/etc/vision-and-tom/secrets"

# Everything this script starts is stopped at the end.
EXTRA=""
cleanup() {
  for u in "$STATE"/*.pid; do [ -e "$u" ] && node "$ROOT/scripts/rehearsal/unit.mjs" stop "$UNITS/$(basename "$u" .pid)" "$STATE" || true; done
  for p in $EXTRA; do kill "$p" 2>/dev/null || true; done
  [ -d "$R/pg" ] && runuser -u postgres -- /usr/lib/postgresql/16/bin/pg_ctl -D "$R/pg" -m fast stop >/dev/null 2>&1 || true
}
trap cleanup EXIT

# A clean start (stop a cluster left over from an interrupted run first).
[ -f "$R/pg/postmaster.pid" ] && runuser -u postgres -- /usr/lib/postgresql/16/bin/pg_ctl -D "$R/pg" -m immediate stop >/dev/null 2>&1 || true
rm -rf "$R" "$LOGS" && mkdir -p "$R" "$LOGS" "$STATE"
# Stand-in for systemctl used by the kit (VT_SVC_HOOK).
cat >"$R/svc-hook.sh" <<HOOK
#!/usr/bin/env bash
# start|stop|restart|enable <unit>
unit="$UNITS/\$2"
case "\$1" in
  enable) echo "\$2" >>"$STATE/enabled"; node "$ROOT/scripts/rehearsal/unit.mjs" start "\$unit" "$STATE" ;;
  start) node "$ROOT/scripts/rehearsal/unit.mjs" start "\$unit" "$STATE" ;;
  stop) node "$ROOT/scripts/rehearsal/unit.mjs" stop "\$unit" "$STATE" ;;
  restart) node "$ROOT/scripts/rehearsal/unit.mjs" stop "\$unit" "$STATE"; node "$ROOT/scripts/rehearsal/unit.mjs" start "\$unit" "$STATE" ;;
esac
HOOK
chmod +x "$R/svc-hook.sh"
export VT_SVC_HOOK="$R/svc-hook.sh"

echo "== 1. PostgreSQL 16 (stand-in for Ubuntu's postgresql-16 service)"
mkdir -p "$R/pg" "$R/pgsock" && chown postgres:postgres "$R/pg" "$R/pgsock" && chmod 700 "$R/pg"
runuser -u postgres -- /usr/lib/postgresql/16/bin/initdb -D "$R/pg" --auth-local=peer --auth-host=scram-sha-256 -U postgres >"$LOGS/initdb.log" 2>&1
runuser -u postgres -- /usr/lib/postgresql/16/bin/pg_ctl -D "$R/pg" -l "$R/pg/postgres.log" -w \
  -o "-p $PG_PORT -k $R/pgsock -c listen_addresses=127.0.0.1" start >/dev/null
check "PostgreSQL 16 is running" "$(runuser -u postgres -- psql -h "$PG_HOST" -p "$PG_PORT" -tAc 'SHOW server_version' | cut -d. -f1)" "16"

echo "== 2. Stand-ins for the outside world: a mail server (password + STARTTLS) and GitHub"
openssl req -x509 -newkey rsa:2048 -nodes -days 2 -subj "/CN=localhost" -addext "subjectAltName=DNS:localhost,IP:127.0.0.1" \
  -keyout "$R/smtp.key" -out "$R/smtp.crt" >/dev/null 2>&1
SMTP_PASS=$(rand)
printf 'owner@example.com:%s\n' "$(openssl passwd -apr1 "$SMTP_PASS")" >"$R/smtp-users"
MAILPIT="$(command -v mailpit || echo "$ROOT/.vendor/mailpit/mailpit")"
"$MAILPIT" --smtp 127.0.0.1:1028 --listen 127.0.0.1:8028 --disable-version-check --smtp-auth-file "$R/smtp-users" \
  --smtp-tls-cert "$R/smtp.crt" --smtp-tls-key "$R/smtp.key" --smtp-require-starttls --database "$R/mailpit.db" >"$LOGS/mailpit.log" 2>&1 &
EXTRA="$EXTRA $!"
GH_TOKEN_VALUE=$(rand 20)
(umask 077 && printf '%s' "$GH_TOKEN_VALUE" >"$R/gh-token")
(cd "$ROOT/email-service" && exec node tests/fake-github.ts 3396 "$R/github" acme/app "$R/gh-token") >"$LOGS/fake-github.log" 2>&1 &
EXTRA="$EXTRA $!"
for _ in $(seq 1 30); do [ -f "$R/github/ready" ] && curl -s -m 1 "$MP_API/messages" >/dev/null 2>&1 && break; sleep 0.5; done
mkdir -p "$R/seed" && git -C "$R/seed" init -q -b main && echo hi >"$R/seed/README.md"
git -C "$R/seed" add . && git -C "$R/seed" -c user.email=t@example.com -c user.name=T commit -q -m init
git -C "$R/seed" -c push.negotiate=false push -q "$R/github/acme/app.git" main
check "stand-ins are up" "$(curl -s "$MP_API/messages" | json 'd.total')/$([ -f "$R/github/ready" ] && echo gh)" "0/gh"

echo "== 3. The owner's steps before installing: the app, install.conf, secrets"
mkdir -p "$VT_ROOT/opt/vision-and-tom" "$VT_ROOT/etc/vision-and-tom"
# The app as the owner downloads it (a copy of this checkout, without local build output).
mkdir -p "$VT_ROOT/opt/vision-and-tom/app"
tar -C "$ROOT" --exclude=./.git --exclude=./.paperclip-data --exclude=./.vendor --exclude=./.test-logs --exclude=node_modules --exclude=dist -cf - . |
  tar -C "$VT_ROOT/opt/vision-and-tom/app" -xf -
sed -e "s/^DOMAIN=.*/DOMAIN=$DOMAIN/" -e "s/^ACME_EMAIL=.*/ACME_EMAIL=owner@example.com/" \
  -e "s/^SMTP_HOST=.*/SMTP_HOST=127.0.0.1/" -e "s/^SMTP_PORT=.*/SMTP_PORT=1028/" -e "s/^SMTP_USER=.*/SMTP_USER=owner@example.com/" \
  -e 's/^MAIL_FROM=.*/MAIL_FROM="Vision and Tom <owner@example.com>"/' -e "s#^GITHUB_REPO=.*#GITHUB_REPO=acme/app#" \
  -e 's/^COMPANY_NAME=.*/COMPANY_NAME="Rehearsal team"/' "$ROOT/deploy/install.conf.example" >"$VT_ROOT/etc/vision-and-tom/install.conf"
cat >>"$VT_ROOT/etc/vision-and-tom/install.conf" <<CONF
# Rehearsal only: other ports, a local certificate authority, local stand-ins.
HTTP_PORT=8080
HTTPS_PORT=8443
PAPERCLIP_PORT=3398
EMAIL_PORT=3397
CADDY_EXTRA=local_certs
SMTP_CA_FILE=$R/smtp.crt
GITHUB_API_URL=$GH/api
GITHUB_GIT_URL=$GH
CONF
check "install.conf has no secrets in it" "$(grep -v '^#' "$VT_ROOT/etc/vision-and-tom/install.conf" | grep -ciE 'pass|token' | tr -d ' ')" "0"
printf '%s\n' "$SMTP_PASS" | "$ROOT/deploy/bin/vt-secret" smtp-password >/dev/null
printf '%s\n' "$GH_TOKEN_VALUE" | "$ROOT/deploy/bin/vt-secret" github-token >/dev/null
printf '%s\n' "$GH_TOKEN_VALUE" | "$ROOT/deploy/bin/vt-secret" github-read-token >/dev/null
unset SMTP_PASS
check "secrets are root-only files" "$(stat -c %a "$SECRETS")/$(stat -c %a "$SECRETS/github-token")" "700/600"

echo "== 4. install.sh"
if ! bash "$VT_ROOT/opt/vision-and-tom/app/deploy/install.sh" >"$LOGS/install.log" 2>&1; then
  echo "  install.sh failed; last lines:"; tail -15 "$LOGS/install.log" | sed 's/^/    /'
fi
check "install.sh finished" "$(tail -1 "$LOGS/install.log" | grep -c 'Installed. Next')" "1"
check "Node is the pinned version (downloaded, checksum checked)" "$("$VT_ROOT/opt/vision-and-tom/node/bin/node" -v)" "v$(sed -n 's/^NODE_VERSION=//p' "$ROOT/deploy/versions.env")"
check "Caddy is the pinned version (downloaded, checksum checked)" "$("$VT_ROOT/opt/vision-and-tom/bin/caddy" version | cut -d' ' -f1)" "v$(sed -n 's/^CADDY_VERSION=\([^ ]*\).*/\1/p' "$ROOT/deploy/versions.env")"
check "Paperclip is the pinned version (from the lockfile)" "$("$VT_ROOT/opt/vision-and-tom/node/bin/node" "$VT_ROOT/opt/vision-and-tom/paperclip/node_modules/paperclipai/dist/index.js" --version)" "2026.1012.0"
check "the agents' tools are installed from their lockfile" "$("$VT_ROOT/opt/vision-and-tom/agents/node_modules/.bin/claude" --version 2>/dev/null | cut -d' ' -f1)" "$(node -p "require('$ROOT/deploy/agents/package.json').dependencies['@anthropic-ai/claude-code']")"
check "Paperclip runs in authenticated mode on the system database" "$(node -p "const c=require('$VT_ROOT/var/lib/paperclip/instances/default/config.json');[c.server.deploymentMode,c.server.exposure,c.server.host,c.database.mode].join('/')")" "authenticated/public/127.0.0.1/postgres"
check "without signing in, Paperclip shows nothing" "$(curl -s -o /dev/null -w '%{http_code}' "$PC/api/companies")" "403"

echo "== 5. HTTPS through Caddy"
CA="$VT_ROOT/var/lib/caddy/caddy/pki/authorities/local/root.crt"
for _ in $(seq 1 30); do [ -f "$CA" ] && break; sleep 1; done
HTTPS=(curl -s --cacert "$CA" --resolve "$DOMAIN:8443:127.0.0.1")
for _ in $(seq 1 30); do "${HTTPS[@]}" -o /dev/null "$URL/api/health" && break; sleep 1; done
check "Paperclip answers over HTTPS (certificate verified)" "$("${HTTPS[@]}" -o /dev/null -w '%{http_code}' "$URL/api/health")" "200"
check "plain HTTP redirects to HTTPS" "$(curl -s -o /dev/null -w '%{http_code} %{redirect_url}' --resolve "$DOMAIN:8080:127.0.0.1" "http://$DOMAIN:8080/x")" "308 https://$DOMAIN/x"
check "public sign-up is refused (accounts only through invites)" "$("${HTTPS[@]}" -o /dev/null -w '%{http_code}' -X POST -H 'content-type: application/json' -d '{"email":"x@example.com","password":"aaaaaaaaaaaaaa","name":"x"}' "$URL/api/auth/sign-up/email")" "403"
MY_IP=$(hostname -I | awk '{print $1}')
check "Paperclip and the email service are not reachable from outside (127.0.0.1 only)" "$(curl -s -m 3 -o /dev/null -w '%{http_code}' "http://$MY_IP:3398/api/health")/$(curl -s -m 3 -o /dev/null -w '%{http_code}' "http://$MY_IP:3397/health")" "000/000"

echo "== 6. vt-setup (the owner's account, company, plugin, settings)"
OWNER_PW=$(rand 12)
if ! OWNER_NAME="Olive Owner" OWNER_EMAIL=owner@example.com OWNER_TIMEZONE=Europe/London OWNER_PASSWORD="$OWNER_PW" \
  VT_INVITE_DEFAULTS='{"agentAdapterType":"process","agentAdapterConfig":{"command":"pwd"},"expiresMinutes":60}' \
  VT_PROJECT_CLONE_URL="$GH/acme/app.git" bash "$KIT_BIN/vt-setup" >"$LOGS/setup.log" 2>&1; then
  echo "  vt-setup failed; last lines:"; tail -15 "$LOGS/setup.log" | sed 's/^/    /'
fi
check "vt-setup finished" "$(grep -c '^==> Done' "$LOGS/setup.log")" "1"
check "the owner became instance admin (Paperclip's one-time bootstrap invite)" "$(grep -c 'you are now the instance admin' "$LOGS/setup.log")" "1"
signin() { # email password -> cookie (via HTTPS, as a browser would)
  "${HTTPS[@]}" -D - -o /dev/null -X POST -H 'content-type: application/json' -H "origin: $URL" -d "{\"email\":\"$1\",\"password\":\"$2\"}" "$URL/api/auth/sign-in/email" |
    sed -n 's/^set-cookie: \([^;]*\).*/\1/Ip' | paste -sd';' -
}
OWNER_COOKIE=$(signin owner@example.com "$OWNER_PW")
check "the owner can sign in over HTTPS and sees the company" "$("${HTTPS[@]}" -H "cookie: $OWNER_COOKIE" "$URL/api/companies" | json '(Array.isArray(d)?d:d.items).map(c=>c.name).join(",")')" "Rehearsal team"
API_KEY=$(cat "$SECRETS/paperclip-api-key")
CID=$(sed -n 's/^VT_COMPANY_ID=//p' "$VT_ROOT/etc/vision-and-tom/email-service.env")
board() { curl -s -H "authorization: Bearer $API_KEY" -H 'content-type: application/json' "$@"; }
PLUGIN_ID=$(board "$PC/api/plugins" | json 'd.find(p=>(p.pluginKey||p.key)==="vision-and-tom.night-agents").id')
people() { board -X POST "$PC/api/plugins/$PLUGIN_ID/data/people" -d "{\"companyId\":\"$CID\",\"params\":{}}"; }
check "the plugin is installed and its settings are valid" "$(people | json 'd.data.ok')" "true"
check "the owner is the first person, with their own agent" "$(people | json 'd.data.people.map(p=>p.email).join(",")')" "owner@example.com"
check "the project repository was cloned for the agents" "$(git -C "$VT_ROOT/var/lib/paperclip/repos/project" log --format=%s -1)" "init"
check "the email service is up behind HTTPS" "$("${HTTPS[@]}" "$URL/vt/health")" "ok"
check "the email service's settings file holds no secret" "$(grep -cF -e "$GH_TOKEN_VALUE" -e "$API_KEY" "$VT_ROOT/etc/vision-and-tom/email-service.env" | tr -d ' ')" "0"

echo "== 7. Invite link: a new person joins through one link"
INVITE_OUT=$(bash "$KIT_BIN/vt-invite" dee@example.com Europe/Paris 2>&1)
LINK=$(echo "$INVITE_OUT" | grep -o "$URL/vt/join/[^ ]*" | head -1)
check "vt-invite prints the link and emails it" "$([ -n "$LINK" ] && echo link)/$(echo "$INVITE_OUT" | grep -c 'Emailed to dee@example.com')" "link/1"
for _ in $(seq 1 20); do [ "$(curl -s "$MP_API/messages" | json 'd.total')" = "1" ] && break; sleep 0.5; done
check "the invite email arrived (SMTP login over STARTTLS) with the same link" "$(curl -s "$MP_API/message/$(curl -s "$MP_API/messages" | json 'd.messages[0].ID')" | json 'd.Text' | grep -cF "$LINK")" "1"
check "opening the link shows the join form for that email" "$("${HTTPS[@]}" "$LINK" | grep -c 'You were invited as <strong>dee@example.com</strong>')" "1"
check "opening it created nothing" "$(people | json 'd.data.people.length')" "1"
DEE_PW=$(rand 12)
JOIN=$("${HTTPS[@]}" -X POST --data-urlencode "name=Dee Doe" --data-urlencode "password=$DEE_PW" --data-urlencode "timezone=Europe/Paris" "$LINK")
check "the join page says the account and agent are ready" "$(echo "$JOIN" | grep -oE '<h1>[^<]*</h1>')" "<h1>You&#39;re in</h1>"
DEE_COOKIE=$(signin dee@example.com "$DEE_PW")
check "Dee's Paperclip account works and is in the company" "$("${HTTPS[@]}" -H "cookie: $DEE_COOKIE" "$URL/api/companies" | json '(Array.isArray(d)?d:d.items).map(c=>c.name).join(",")')" "Rehearsal team"
DEE_AGENT=$(people | json 'd.data.people.find(p=>p.email==="dee@example.com").agentId')
check "Dee's row is in the plugin settings, bound to one new agent" "$([ -n "$DEE_AGENT" ] && echo yes)/$(people | json 'd.data.people.find(p=>p.email==="dee@example.com").timezone')" "yes/Europe/Paris"
check "Dee's agent has safe defaults (no agent or skill creation, budget set)" "$(board "$PC/api/agents/$DEE_AGENT" | json '[d.name,d.permissions.canCreateAgents,d.permissions.canCreateSkills,d.role,d.budgetMonthlyCents].join("/")')" "Dee Doe's night agent/false/false/engineer/3000"
check "the plugin's route audit accepts Dee's agent" "$(board -X POST "$PC/api/plugins/$PLUGIN_ID/data/route-audit" -d "{\"companyId\":\"$CID\",\"params\":{}}" | json 'd.data.ok')" "true"
check "a used invite link is refused (POST)" "$("${HTTPS[@]}" -o /dev/null -w '%{http_code}' -X POST --data-urlencode "name=Mallory" --data-urlencode "password=$(rand 12)" "$LINK")/$("${HTTPS[@]}" -X POST --data-urlencode "name=M" --data-urlencode "password=$(rand 12)" "$LINK" | grep -oE '<h1>[^<]*</h1>')" "409/<h1>Invite already used</h1>"
check "a used invite link is refused (opening it)" "$("${HTTPS[@]}" "$LINK" | grep -oE '<h1>[^<]*</h1>')" "<h1>Invite already used</h1>"
check "still exactly two people" "$(people | json 'd.data.people.length')" "2"
FORGED="${LINK%?}$( [ "${LINK: -1}" = A ] && echo B || echo A )"
check "a forged invite link is refused" "$("${HTTPS[@]}" "$FORGED" | grep -oE '<h1>[^<]*</h1>')" "<h1>Invite not usable</h1>"

echo "-- an expired invite link is refused"
CFG=$(board "$PC/api/plugins/$PLUGIN_ID/config?companyId=$CID" | json 'd.configJson')
board -X POST "$PC/api/plugins/$PLUGIN_ID/config" -d "{\"companyId\":\"$CID\",\"configJson\":$(echo "$CFG" | json '({...d,invites:{...d.invites,expiresMinutes:1}})')}" >/dev/null
EXP_LINK=$(VT_INVITE_NO_EMAIL=1 bash "$KIT_BIN/vt-invite" eve@example.com 2>&1 | grep -o "$URL/vt/join/[^ ]*" | head -1)
check "a 1-minute invite works before it expires (opening it)" "$("${HTTPS[@]}" "$EXP_LINK" | grep -c 'You were invited as')" "1"
echo "  waiting 65s for it to expire..."; sleep 65
check "the expired invite link is refused (opening it)" "$("${HTTPS[@]}" "$EXP_LINK" | grep -oE '<h1>[^<]*</h1>')" "<h1>Invite expired</h1>"
check "the expired invite link is refused (POST), no account made" "$("${HTTPS[@]}" -o /dev/null -w '%{http_code}' -X POST --data-urlencode "name=Eve" --data-urlencode "password=$(rand 12)" "$EXP_LINK")/$(signin eve@example.com whatever-password | grep -c . | tr -d ' ')" "409/0"
board -X POST "$PC/api/plugins/$PLUGIN_ID/config" -d "{\"companyId\":\"$CID\",\"configJson\":$CFG}" >/dev/null

echo "== 8. vt-check (what the owner runs to see that everything works)"
bash "$KIT_BIN/vt-backup" >"$LOGS/backup1.log" 2>&1
# Caddy's local test certificates last 12 hours (Let's Encrypt's: 90 days), so no 7-day minimum here.
VT_CHECK_URL="$URL" VT_CHECK_CACERT="$CA" VT_CHECK_MIN_CERT_DAYS=0 bash "$KIT_BIN/vt-check" >"$LOGS/check.log" 2>&1 || true
check "vt-check says All good" "$(tail -1 "$LOGS/check.log")" "All good."

echo "== 9. Daily backup, a disaster, and the restore"
sleep 1
bash "$KIT_BIN/vt-backup" >"$LOGS/backup.log" 2>&1
BACKUP=$(ls -1t "$VT_ROOT/var/backups/vision-and-tom"/vt-backup-*.tar | head -1)
check "the backup file exists and only root can read it" "$(stat -c %a "$BACKUP")" "600"
check "the backup has the database, the files and a checksum list" "$(tar -tf "$BACKUP" | sort | tr '\n' ' ')" "MANIFEST files.tar.gz paperclip.dump "
echo "-- disaster: the database and all of Paperclip's files are gone"
"$R/svc-hook.sh" stop vt-email.service; "$R/svc-hook.sh" stop paperclip.service
runuser -u postgres -- env PGHOST="$PG_HOST" PGPORT="$PG_PORT" dropdb paperclip
rm -rf "$VT_ROOT/var/lib/paperclip"
check "Paperclip is down" "$(curl -s -o /dev/null -w '%{http_code}' "$URL/api/health" --cacert "$CA" --resolve "$DOMAIN:8443:127.0.0.1")" "502"
if ! bash "$KIT_BIN/vt-restore" "$BACKUP" >"$LOGS/restore.log" 2>&1; then
  echo "  vt-restore failed; last lines:"; tail -15 "$LOGS/restore.log" | sed 's/^/    /'
fi
check "vt-restore finished" "$(grep -c '^==> Restored from' "$LOGS/restore.log")" "1"
check "after the restore: the owner signs in" "$(signin owner@example.com "$OWNER_PW" | grep -c . | tr -d ' ')" "1"
check "after the restore: Dee signs in and sees the company" "$("${HTTPS[@]}" -H "cookie: $(signin dee@example.com "$DEE_PW")" "$URL/api/companies" | json '(Array.isArray(d)?d:d.items).length')" "1"
check "after the restore: both people are in the plugin settings" "$(people | json 'd.data.people.map(p=>p.email).sort().join(",")')" "dee@example.com,owner@example.com"
check "after the restore: Dee's used invite is still refused" "$("${HTTPS[@]}" "$LINK" | grep -oE '<h1>[^<]*</h1>')" "<h1>Invite already used</h1>"
NEW_LINK=$(VT_INVITE_NO_EMAIL=1 bash "$KIT_BIN/vt-invite" fay@example.com 2>&1 | grep -o "$URL/vt/join/[^ ]*" | head -1)
check "after the restore: Paperclip's encrypted secrets still open (a new invite is signed and works)" "$("${HTTPS[@]}" "$NEW_LINK" | grep -c 'You were invited as <strong>fay@example.com')" "1"
check "the old data was moved aside, not deleted" "$(ls -d "$VT_ROOT/var/backups/vision-and-tom"/before-restore-*/ | wc -l | tr -d ' ')" "1"
echo "-- a damaged backup is refused before anything changes"
cp "$BACKUP" "$R/damaged.tar" && printf 'x' | dd of="$R/damaged.tar" bs=1 seek=2000 conv=notrunc 2>/dev/null
check "vt-restore refuses a damaged backup, Paperclip keeps running" "$(bash "$KIT_BIN/vt-restore" "$R/damaged.tar" 2>&1 | grep -c 'nothing was changed')/$(curl -s -o /dev/null -w '%{http_code}' "$PC/api/health")" "1/200"

echo "== 10. Simulated reboot: everything stops, then starts as the unit files say"
for u in $(tac "$STATE/enabled" | awk '!s[$0]++'); do "$R/svc-hook.sh" stop "$u"; done
runuser -u postgres -- /usr/lib/postgresql/16/bin/pg_ctl -D "$R/pg" -m fast -w stop >/dev/null
check "everything is down" "$(curl -s -o /dev/null -w '%{http_code}' "$PC/api/health")" "000"
runuser -u postgres -- /usr/lib/postgresql/16/bin/pg_ctl -D "$R/pg" -l "$R/pg/postgres.log" -w -o "-p $PG_PORT -k $R/pgsock -c listen_addresses=127.0.0.1" start >/dev/null
for u in $(awk '!s[$0]++' "$STATE/enabled"); do "$R/svc-hook.sh" start "$u"; done
for _ in $(seq 1 90); do "${HTTPS[@]}" -o /dev/null "$URL/vt/health" 2>/dev/null && curl -fs -o /dev/null "$PC/api/health" && break; sleep 1; done
check "the services that start at boot" "$(awk '!s[$0]++' "$STATE/enabled" | sort | tr '\n' ' ')" "caddy.service paperclip.service vt-email.service "
check "after the reboot: Paperclip and the email service answer over HTTPS" "$("${HTTPS[@]}" -o /dev/null -w '%{http_code}' "$URL/api/health")/$("${HTTPS[@]}" "$URL/vt/health")" "200/ok"
check "after the reboot: data is still there" "$(people | json 'd.data.people.length')" "2"
for unit in paperclip vt-email caddy; do
  check "$unit.service restarts by itself and starts at boot" "$(grep -c '^Restart=always$' "$UNITS/$unit.service")/$(grep -c '^WantedBy=multi-user.target$' "$UNITS/$unit.service")" "1/1"
done
check "the daily backup timer runs every day and catches up after downtime" "$(grep -c '^OnCalendar=\*-\*-\* 03:30:00$' "$UNITS/vt-backup.timer")/$(grep -c '^Persistent=true$' "$UNITS/vt-backup.timer")" "1/1"
if command -v systemd-analyze >/dev/null && systemd-analyze --version >/dev/null 2>&1; then
  SA=$(cd "$UNITS" && SYSTEMD_LOG_LEVEL=err systemd-analyze verify --man=no ./*.service ./*.timer 2>&1 | grep -v -E "unknown user|No such file|Failed to resolve (user|group)|is not executable|has no installed|Unit .* not found" || true)
  check "systemd-analyze finds no errors in the unit files (users only exist on the server)" "$SA" ""
fi

echo "== 11. Secrets stay with the service that needs them"
check "the GitHub token is in no Paperclip file" "$(grep -rlF "$GH_TOKEN_VALUE" "$VT_ROOT/var/lib/paperclip" --exclude-dir=repos 2>/dev/null | wc -l | tr -d ' ')" "0"
check "the GitHub token is not in the database" "$(runuser -u postgres -- env PGHOST="$PG_HOST" PGPORT="$PG_PORT" pg_dump paperclip | grep -cF "$GH_TOKEN_VALUE" | tr -d ' ')" "0"
check "the push token is only given to the email service unit" "$(grep -l 'github-token' "$UNITS"/*.service | xargs -n1 basename | tr '\n' ' ')" "vt-email.service "

echo
echo "Result: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
