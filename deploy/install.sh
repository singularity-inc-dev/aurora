#!/usr/bin/env bash
# Vision and Tom server installer (Ubuntu 24.04). Safe to run again: it only
# adds what is missing and never deletes data or overwrites your secrets.
#
#   sudo bash /opt/vision-and-tom/app/deploy/install.sh
#
# Before: put /etc/vision-and-tom/install.conf in place (DEPLOY.md, step 6).
# After:  sudo /opt/vision-and-tom/app/deploy/bin/vt-setup
. "$(cd "$(dirname "$0")" && pwd)/lib/common.sh"
need_root
load_conf
ARCH="$(uname -m)"
case "$ARCH" in
  x86_64) NODE_ARCH=x64; NODE_SHA=$NODE_SHA256_X64; CADDY_ARCH=amd64; CADDY_SHA=$CADDY_SHA512_X64 ;;
  aarch64) NODE_ARCH=arm64; NODE_SHA=$NODE_SHA256_ARM64; CADDY_ARCH=arm64; CADDY_SHA=$CADDY_SHA512_ARM64 ;;
  *) die "unsupported processor $ARCH (use a 64-bit Intel/AMD or ARM server)" ;;
esac
[ -f "$APP/plugin/package.json" ] || die "the app is not at $APP (DEPLOY.md, step 5)"

if ! rehearsal; then
  . /etc/os-release
  [ "$VERSION_ID" = "$UBUNTU_RELEASE" ] || die "this kit is tested on Ubuntu $UBUNTU_RELEASE; this server runs Ubuntu $VERSION_ID"
  say "1/9 System packages (PostgreSQL $POSTGRES_MAJOR from Ubuntu, git, firewall)"
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -q
  apt-get install -y -q "postgresql-$POSTGRES_MAJOR" git curl ca-certificates openssl xz-utils ufw util-linux
  # Ubuntu's security updates still apply; only a jump to another major version is blocked.
  apt-mark hold "postgresql-$POSTGRES_MAJOR" >/dev/null
  systemctl enable --now postgresql

  say "2/9 Users: paperclip (Paperclip and its agents), vt-mail (email service), caddy (HTTPS)"
  id paperclip >/dev/null 2>&1 || useradd --system --home-dir "$PCDATA" --create-home --shell /bin/bash paperclip
  id vt-mail >/dev/null 2>&1 || useradd --system --home-dir "$MAILDATA" --create-home --shell /usr/sbin/nologin vt-mail
  id caddy >/dev/null 2>&1 || useradd --system --home-dir /var/lib/caddy --create-home --shell /usr/sbin/nologin caddy
  usermod -aG paperclip vt-mail
fi
mkdir -p "$OPT/bin" "$ETC" "$SECRETS" "$PCDATA/repos" "$MAILDATA" "$BACKUPS"
chmod 755 "$OPT" "$OPT/bin"
chmod 750 "$ETC" && chmod 700 "$SECRETS" "$BACKUPS"
if ! rehearsal; then
  chown paperclip:paperclip "$PCDATA" "$PCDATA/repos" && chmod 750 "$PCDATA"
  chown vt-mail:vt-mail "$MAILDATA" && chmod 700 "$MAILDATA"
fi

download() { # url file algo sum
  curl -fsSL --retry 3 -o "$2" "$1"
  echo "$4  $2" | "${3}sum" -c --quiet - || { rm -f "$2"; die "download of $(basename "$2") does not match its pinned checksum"; }
}

say "3/9 Node.js $NODE_VERSION (checksum-verified)"
if [ "$("$NODE_BIN/node" -v 2>/dev/null || true)" != "v$NODE_VERSION" ]; then
  tmp=$(mktemp -d)
  download "https://nodejs.org/dist/v$NODE_VERSION/node-v$NODE_VERSION-linux-$NODE_ARCH.tar.xz" "$tmp/node.tar.xz" sha256 "$NODE_SHA"
  rm -rf "$OPT/node" && mkdir -p "$OPT/node"
  tar -xJf "$tmp/node.tar.xz" -C "$OPT/node" --strip-components=1 && rm -rf "$tmp"
fi
export PATH="$NODE_BIN:$PATH"
[ "$(pnpm -v 2>/dev/null || true)" = "$PNPM_VERSION" ] || npm install -g --no-audit --no-fund "pnpm@$PNPM_VERSION" >/dev/null

say "4/9 Caddy $CADDY_VERSION (checksum-verified)"
if ! "$OPT/bin/caddy" version 2>/dev/null | grep -q "^v$CADDY_VERSION "; then
  tmp=$(mktemp -d)
  download "https://github.com/caddyserver/caddy/releases/download/v$CADDY_VERSION/caddy_${CADDY_VERSION}_linux_$CADDY_ARCH.tar.gz" "$tmp/caddy.tgz" sha512 "$CADDY_SHA"
  tar -xzf "$tmp/caddy.tgz" -C "$OPT/bin" caddy && chmod 755 "$OPT/bin/caddy" && rm -rf "$tmp"
fi

say "5/9 Paperclip $PAPERCLIP_VERSION and the agents' tools (exact versions from lockfiles)"
mkdir -p "$OPT/paperclip" "$OPT/agents"
cp "$KIT/paperclip/package.json" "$KIT/paperclip/pnpm-lock.yaml" "$KIT/paperclip/.npmrc" "$OPT/paperclip/"
# pnpm with a flat node_modules (.npmrc); install scripts of dependencies are not run.
(cd "$OPT/paperclip" && pnpm install --frozen-lockfile --prod >/dev/null)
if [ "${VT_SKIP_AGENT_TOOLS:-0}" != "1" ]; then
  cp "$KIT/agents/package.json" "$KIT/agents/package-lock.json" "$OPT/agents/"
  (cd "$OPT/agents" && npm ci --omit=dev --no-audit --no-fund >/dev/null)
fi

say "6/9 The plugin and the email service (exact versions from lockfiles)"
(cd "$APP/plugin" && pnpm install --frozen-lockfile >/dev/null && pnpm build >/dev/null)
(cd "$APP/email-service" && pnpm install --frozen-lockfile --prod >/dev/null)
# Paperclip and the agents may read the app but never change it.
rehearsal || { chown -R root:root "$APP"; chmod -R go-w "$APP"; }

say "7/9 Database"
if [ ! -s "$SECRETS/db-url" ]; then
  DB_PASS=$(openssl rand -hex 24)
  # The password goes in on standard input, never on a command line other users could see.
  if pg psql -q -d postgres -tc "SELECT 1 FROM pg_roles WHERE rolname='paperclip'" | grep -q 1; then
    echo "ALTER ROLE paperclip LOGIN PASSWORD '$DB_PASS';" | pg psql -v ON_ERROR_STOP=1 -q -d postgres
  else
    echo "CREATE ROLE paperclip LOGIN PASSWORD '$DB_PASS';" | pg psql -v ON_ERROR_STOP=1 -q -d postgres
  fi
  pg psql -q -d postgres -tc "SELECT 1 FROM pg_database WHERE datname='paperclip'" | grep -q 1 || pg createdb -O paperclip paperclip
  write_secret db-url "postgres://paperclip:$DB_PASS@127.0.0.1:$PG_PORT/paperclip"
  unset DB_PASS
fi

say "8/9 Settings files"
mkdir -p "$PCINSTANCE"
# Paperclip's sign-in sessions and agent tokens are signed with these (made once, kept).
if [ ! -s "$PCINSTANCE/.env" ]; then
  (umask 077 && printf 'BETTER_AUTH_SECRET=%s\nPAPERCLIP_AGENT_JWT_SECRET=%s\n' "$(openssl rand -hex 32)" "$(openssl rand -hex 32)" >"$PCINSTANCE/.env")
fi
"$NODE_BIN/node" "$KIT/templates/paperclip-config.mjs" "$PCINSTANCE/config.json" "$PCINSTANCE" "$PUBLIC_URL" "$DOMAIN" "${PAPERCLIP_PORT:-3100}" "$SECRETS/db-url"
rehearsal || chown -R paperclip:paperclip "$PCDATA/instances"
cat >"$ETC/caddy.env" <<CADDY
VT_DOMAIN=$DOMAIN$([ "$HTTPS_PORT" = "443" ] || echo ":$HTTPS_PORT")
VT_ACME_EMAIL=$ACME_EMAIL
VT_HTTP_PORT=${HTTP_PORT:-80}
VT_HTTPS_PORT=$HTTPS_PORT
VT_EMAIL_PORT=${EMAIL_PORT:-3299}
VT_PAPERCLIP_PORT=${PAPERCLIP_PORT:-3100}
VT_CADDY_EXTRA=${CADDY_EXTRA:-}
CADDY
cp "$KIT/templates/Caddyfile" "$ETC/Caddyfile"
# The company id is filled in by vt-setup; keep it when re-installing.
OLD_COMPANY=$(sed -n 's/^VT_COMPANY_ID=//p' "$ETC/email-service.env" 2>/dev/null || true)
cat >"$ETC/email-service.env" <<MAIL
# Written by install.sh from install.conf. Secrets are not here (see $SECRETS).
PAPERCLIP_URL=http://127.0.0.1:${PAPERCLIP_PORT:-3100}
PAPERCLIP_PUBLIC_URL=$PUBLIC_URL
VT_COMPANY_ID=$OLD_COMPANY
SMTP_HOST=$SMTP_HOST
SMTP_PORT=$SMTP_PORT
SMTP_REQUIRE_TLS=$([ "$SMTP_PORT" = "465" ] && echo false || echo true)
SMTP_USER=$SMTP_USER
MAIL_FROM=$MAIL_FROM
LISTEN_HOST=127.0.0.1
LISTEN_PORT=${EMAIL_PORT:-3299}
POLL_SECONDS=60
GITHUB_API_URL=${GITHUB_API_URL:-https://api.github.com}
GITHUB_GIT_URL=${GITHUB_GIT_URL:-https://github.com}
GITHUB_SYNC_MINUTES=10
${SMTP_CA_FILE:+SMTP_CA_FILE=$SMTP_CA_FILE}
MAIL
chmod 640 "$ETC"/*.env "$ETC/Caddyfile"
rehearsal || chgrp caddy "$ETC/caddy.env" "$ETC/Caddyfile"
rehearsal || { chgrp caddy "$ETC"; }

say "9/9 Services, daily backup, restart after reboot, firewall"
mkdir -p "$SYSTEMD_DIR"
for unit in "$KIT"/systemd/*; do
  sed -e "s#@OPT@#$OPT#g" -e "s#@ETC@#$ETC#g" -e "s#@PCDATA@#$PCDATA#g" -e "s#@MAILDATA@#$MAILDATA#g" -e "s#@VTROOT@#$VT_ROOT#g" -e "s#@BASE@#${GITHUB_BASE_BRANCH:-main}#g" -e "s#@PUBLIC_URL@#$PUBLIC_URL#g" "$unit" >"$SYSTEMD_DIR/$(basename "$unit")"
done
for cmd in vt-invite vt-secret vt-check vt-backup vt-restore vt-setup; do
  ln -sf "$KIT/bin/$cmd" "$OPT/bin/$cmd"
  rehearsal || ln -sf "$OPT/bin/$cmd" "/usr/local/bin/$cmd"
done
if ! rehearsal; then
  mkdir -p /var/lib/caddy && chown caddy:caddy /var/lib/caddy
  systemctl daemon-reload
  systemctl enable --now paperclip.service caddy.service vt-backup.timer
  # The email service and the repo sync start after vt-setup (they need its results).
  ufw allow OpenSSH >/dev/null && ufw allow 80/tcp >/dev/null && ufw allow 443/tcp >/dev/null && ufw --force enable >/dev/null
else
  svc enable paperclip.service
  svc enable caddy.service
fi
wait_http "http://127.0.0.1:${PAPERCLIP_PORT:-3100}/api/health" 180 || die "Paperclip did not start (see: journalctl -u paperclip -n 50)"
say "Installed. Next: sudo $KIT/bin/vt-setup"
