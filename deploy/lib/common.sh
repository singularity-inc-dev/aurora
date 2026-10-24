# Shared by every deploy script. Sourced, not run.
#
# VT_ROOT  prefix for every path (empty on the real server). The rehearsal sets it
#          to a folder so the real scripts run without touching the system.
# VT_REHEARSAL=1  skip system changes (apt, users, systemctl, firewall) and use
#          the hooks the rehearsal provides instead.
set -euo pipefail
umask 027

VT_ROOT="${VT_ROOT:-}"
KIT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=/dev/null
. "$KIT/versions.env"

OPT="$VT_ROOT/opt/vision-and-tom"
ETC="$VT_ROOT/etc/vision-and-tom"
SECRETS="$ETC/secrets"
PCDATA="$VT_ROOT/var/lib/paperclip"
PCINSTANCE="$PCDATA/instances/default"
MAILDATA="$VT_ROOT/var/lib/vt-mail"
BACKUPS="$VT_ROOT/var/backups/vision-and-tom"
APP="$OPT/app"
NODE_BIN="$OPT/node/bin"
SYSTEMD_DIR="$VT_ROOT/etc/systemd/system"
PG_HOST="${PG_HOST:-/var/run/postgresql}"
PG_PORT="${PG_PORT:-5432}"
PG_SUPERUSER="${PG_SUPERUSER:-postgres}"

say() { printf '\n==> %s\n' "$*"; }
die() { printf '\nSTOPPED: %s\n' "$*" >&2; exit 1; }
rehearsal() { [ "${VT_REHEARSAL:-0}" = "1" ]; }

need_root() { [ "$(id -u)" = "0" ] || die "run this with sudo (as root)"; }

load_conf() {
  [ -f "$ETC/install.conf" ] || die "missing $ETC/install.conf (copy deploy/install.conf.example there and fill it in, see DEPLOY.md)"
  # shellcheck source=/dev/null
  . "$ETC/install.conf"
  [ -n "${DOMAIN:-}" ] || die "DOMAIN is empty in install.conf"
  [ -n "${ACME_EMAIL:-}" ] || die "ACME_EMAIL is empty in install.conf"
  [ -n "${SMTP_HOST:-}" ] || die "SMTP_HOST is empty in install.conf"
  [ -n "${MAIL_FROM:-}" ] || die "MAIL_FROM is empty in install.conf"
  HTTPS_PORT="${HTTPS_PORT:-443}"
  PUBLIC_URL="https://$DOMAIN$([ "$HTTPS_PORT" = "443" ] || echo ":$HTTPS_PORT")"
}

# Run a command as the PostgreSQL superuser (peer login over the local socket).
pg() { runuser -u "$PG_SUPERUSER" -- env PGHOST="$PG_HOST" PGPORT="$PG_PORT" "$@"; }

# Start/stop a service: systemd on the server, the rehearsal's hook otherwise.
svc() { # start|stop|restart|enable name
  if rehearsal; then "${VT_SVC_HOOK:?}" "$1" "$2"; else
    case "$1" in enable) systemctl enable --now "$2" ;; *) systemctl "$1" "$2" ;; esac
  fi
}

# Wait until a URL answers 200 (seconds).
wait_http() { # url seconds
  for _ in $(seq 1 "${2:-60}"); do curl -fsS -m 2 -o /dev/null "$1" 2>/dev/null && return 0; sleep 1; done
  return 1
}

# Write a secret file readable only by root (systemd hands it to the one service that needs it).
write_secret() { # name value
  mkdir -p "$SECRETS" && chmod 700 "$SECRETS"
  (umask 077 && printf '%s' "$2" >"$SECRETS/$1")
}
