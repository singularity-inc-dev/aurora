# Agent system users (thin version 1, piece A). Sourced after common.sh, as root.
#
# Each person's agent runs as a system user of its own, reached by Paperclip over
# SSH on 127.0.0.1. That user is not in the paperclip group, so it cannot read
# Paperclip's data, its secrets or the link signing key.
#
# agent_prepare <email> makes (or reuses) the user and two fresh keys:
#   - Paperclip's key: from="127.0.0.1,::1",restrict (commands only, no forwarding)
#   - the checks key: restrict,command="vt-check-runner" (it can do nothing else)
# The public halves go in a root-owned authorized_keys file under /etc/ssh (sshd
# reads it as the agent's user, so it cannot live in the closed /etc/vision-and-tom);
# the private halves
# in a root-only folder ($AGENT_KEYS) until they are handed to Paperclip, after
# which agent_cleanup deletes them. AGENT_LOGIN holds the JSON for the Node side.

AGENT_AUTH_DIR="$VT_ROOT/etc/ssh/vision-and-tom"
AGENT_SSH_PORT="${VT_SSH_PORT:-22}"

# A stable user name per email: vt-a- plus 10 hex characters of its SHA-256.
agent_user_for() { printf 'vt-a-%s' "$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]' | sha256sum | cut -c1-10)"; }

# The rehearsal cannot add users to this machine; it hands over a few test users instead.
rehearsal_agent_user() { # email
  local map="$ETC/rehearsal-agent-users" email; email=$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]')
  touch "$map"
  local found; found=$(awk -v e="$email" '$1==e{print $2}' "$map")
  if [ -z "$found" ]; then
    for u in ${VT_REHEARSAL_AGENT_USERS:?}; do grep -q " $u\$" "$map" || { found=$u; break; }; done
    # Out of test users: share the last one (rehearsal only; such invites are never joined).
    [ -n "$found" ] || found=${VT_REHEARSAL_AGENT_USERS##* }
    echo "$email $found" >>"$map"
  fi
  printf '%s' "$found"
}

agent_known_hosts() {
  local pub="${VT_SSH_HOST_KEY_PUB:-/etc/ssh/ssh_host_ed25519_key.pub}" host="127.0.0.1"
  [ -s "$pub" ] || die "no SSH host key at $pub (is openssh-server installed?)"
  [ "$AGENT_SSH_PORT" = "22" ] || host="[127.0.0.1]:$AGENT_SSH_PORT"
  printf '%s %s' "$host" "$(cut -d' ' -f1-2 "$pub")"
}

agent_prepare() { # email
  local email="$1" user
  if rehearsal; then
    user=$(rehearsal_agent_user "$email")
    id "$user" >/dev/null 2>&1 || die "rehearsal agent user $user does not exist (scripts/it/lib/setup-test-users.sh)"
  else
    user=$(agent_user_for "$email")
    if ! id "$user" >/dev/null 2>&1; then
      useradd --system --user-group --create-home --home-dir "/home/$user" --shell /bin/bash --comment "agent of $email" "$user"
    fi
    usermod -p '*' "$user" # key login only ("!" would lock it for sshd)
    # Never in Paperclip's group: that group can read Paperclip's files.
    id -nG "$user" | tr ' ' '\n' | grep -qx paperclip && die "$user is in the paperclip group; remove it first (gpasswd -d $user paperclip)"
    chmod 700 "/home/$user"
  fi
  AGENT_USER="$user"
  AGENT_KEYS=$(mktemp -d "${TMPDIR:-/tmp}/vt-agent-keys.XXXXXX")
  chmod 700 "$AGENT_KEYS"
  ssh-keygen -q -t ed25519 -N "" -C "paperclip-run@$user" -f "$AGENT_KEYS/run" >/dev/null
  ssh-keygen -q -t ed25519 -N "" -C "vt-checks@$user" -f "$AGENT_KEYS/checks" >/dev/null
  mkdir -p "$AGENT_AUTH_DIR" && chmod 755 "$AGENT_AUTH_DIR"
  local file="$AGENT_AUTH_DIR/$user" keep=""
  # The owner's own login key (Claude Code's sign-in, piece B) survives; the two machine keys are replaced.
  [ -f "$file" ] && keep=$(grep ' vt-owner-login$' "$file" || true)
  {
    [ -n "$keep" ] && printf '%s\n' "$keep"
    # Rehearsal only: a shared test user keeps the keys of earlier invitees too.
    if rehearsal && [ -f "$file" ]; then grep -v ' vt-owner-login$' "$file" || true; fi
    printf 'from="127.0.0.1,::1",restrict %s\n' "$(cut -d' ' -f1-2 "$AGENT_KEYS/run.pub")"
    printf 'restrict,command="%s" %s\n' "$APP/deploy/bin/vt-check-runner" "$(cut -d' ' -f1-2 "$AGENT_KEYS/checks.pub")"
  } >"$file.new"
  chmod 644 "$file.new" && mv "$file.new" "$file"
  AGENT_LOGIN=$(printf '{"user":"%s","host":"127.0.0.1","port":%s,"knownHosts":"%s","runKeyFile":"%s","checksKeyFile":"%s"}' \
    "$user" "$AGENT_SSH_PORT" "$(agent_known_hosts)" "$AGENT_KEYS/run" "$AGENT_KEYS/checks")
  export AGENT_LOGIN
}

agent_cleanup() { [ -n "${AGENT_KEYS:-}" ] && rm -rf "$AGENT_KEYS"; AGENT_KEYS=""; }
