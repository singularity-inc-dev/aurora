# SSH test bed for the agent-isolation checks. Sourced (needs ROOT, LOG_DIR, EXTRA_PIDS).
#
# Starts a private sshd on 127.0.0.1:$SSHBED_PORT with the same rules as the
# server's drop-in (deploy/templates/sshd-vision-and-tom.conf): key login only,
# keys in a root-owned folder, no forwarding. Like the server's
# ProtectProc=invisible on ssh.service, its sessions get their own /proc with
# hidepid=invisible: a user sees only its own processes (and so never another
# user's command lines, where Paperclip puts run tokens).
#
# Needs the test users from scripts/it/lib/setup-test-users.sh.

SSHBED_PORT="${SSHBED_PORT:-2299}"
SSHBED="${SSHBED:-$ROOT/.paperclip-data/sshbed}"
# Where authorized_keys files live (the rehearsal points this at the kit's own folder).
SSHBED_AUTH_DIR="${SSHBED_AUTH_DIR:-$SSHBED/authorized_keys}"

sshbed_require() {
  [ "$(id -u)" = "0" ] && [ "$(uname -s)" = "Linux" ] || { echo "  the isolation checks need Linux and root (the cloud test machine)"; return 1; }
  command -v sshd >/dev/null && command -v ssh >/dev/null && id vt-agent-ana >/dev/null 2>&1 && id vt-agent-bo >/dev/null 2>&1 && id vt-checks >/dev/null 2>&1 ||
    { echo "  missing OpenSSH or test users: run scripts/it/lib/setup-test-users.sh first (changes this machine; ask the owner)"; return 1; }
}

# sshbed_start : fresh host key and config; prints nothing on success.
sshbed_start() {
  sshbed_stop
  rm -rf "$SSHBED" && mkdir -p "$SSHBED/keys" "$SSHBED_AUTH_DIR" && chmod 711 "$SSHBED" && chmod 700 "$SSHBED/keys" && chmod 755 "$SSHBED_AUTH_DIR"
  ssh-keygen -q -t ed25519 -N "" -f "$SSHBED/host_key" >/dev/null
  mkdir -p /run/sshd && chmod 755 /run/sshd
  cat >"$SSHBED/sshd_config" <<CFG
Port $SSHBED_PORT
ListenAddress 127.0.0.1
HostKey $SSHBED/host_key
PidFile $SSHBED/sshd.pid
UsePAM no
PermitRootLogin no
AllowUsers vt-agent-ana vt-agent-bo vt-checks
AuthorizedKeysFile $SSHBED_AUTH_DIR/%u
AuthenticationMethods publickey
PasswordAuthentication no
KbdInteractiveAuthentication no
AllowTcpForwarding no
AllowStreamLocalForwarding no
AllowAgentForwarding no
X11Forwarding no
PermitTunnel no
GatewayPorts no
PermitUserRC no
PermitUserEnvironment no
PrintMotd no
UseDNS no
LogLevel VERBOSE
CFG
  # Its own /proc with hidepid=invisible (the server: ProtectProc=invisible on ssh.service).
  unshare --mount --propagation private sh -c "mount -t proc -o hidepid=invisible proc /proc && exec /usr/sbin/sshd -D -f '$SSHBED/sshd_config' -E '$LOG_DIR/sshbed.log'" </dev/null >/dev/null 2>&1 &
  SSHBED_PID=$!
  EXTRA_PIDS="$EXTRA_PIDS $SSHBED_PID"
  for _ in $(seq 1 40); do [ -s "$SSHBED/sshd.pid" ] && break; sleep 0.25; done
  [ -s "$SSHBED/sshd.pid" ] || { echo "  sshd did not start:"; tail -5 "$LOG_DIR/sshbed.log"; return 1; }
  SSHBED_KNOWN_HOSTS="[127.0.0.1]:$SSHBED_PORT $(cut -d' ' -f1-2 "$SSHBED/host_key.pub")"
}

sshbed_stop() {
  if [ -s "$SSHBED/sshd.pid" ]; then kill "$(cat "$SSHBED/sshd.pid")" 2>/dev/null || true; rm -f "$SSHBED/sshd.pid"; fi
}

# sshbed_key <name> : a fresh client key pair in $SSHBED/keys/<name> (private key stays in the root-only folder).
sshbed_key() { ssh-keygen -q -t ed25519 -N "" -C "$1" -f "$SSHBED/keys/$1" >/dev/null; }

# sshbed_authorize <user> <keyname> [options] : add that public key for the user (root-owned file, 644).
sshbed_authorize() {
  printf '%s %s\n' "${3:-restrict}" "$(cat "$SSHBED/keys/$2.pub")" >>"$SSHBED_AUTH_DIR/$1"
  chmod 644 "$SSHBED_AUTH_DIR/$1"
}

# sshbed_ssh <user> <keyname> <command...> : run a command as that user through the bed.
sshbed_ssh() {
  local user="$1" key="$2"; shift 2
  ssh -o BatchMode=yes -o StrictHostKeyChecking=yes -o "UserKnownHostsFile=$SSHBED/known_hosts" -i "$SSHBED/keys/$key" -p "$SSHBED_PORT" "$user@127.0.0.1" "$@"
}
sshbed_known_hosts() { printf '%s\n' "$SSHBED_KNOWN_HOSTS" >"$SSHBED/known_hosts"; }
