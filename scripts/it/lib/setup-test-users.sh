#!/usr/bin/env bash
# One-time setup of the cloud test machine for the agent-isolation checks
# (scripts/it/v1a.sh and v1b.sh). It changes the machine itself, so run it only
# where the owner agreed (CLAUDE.md hard rule 2); never on a laptop or a server.
#
#   sudo scripts/it/lib/setup-test-users.sh
#
# - OpenSSH from Ubuntu (client and server). It is never started as a system service here.
# - Test users: vt-agent-ana and vt-agent-bo (stand-ins for two owners' agents)
#   and vt-checks (the checks sandbox). Private homes, no passwords.
set -euo pipefail
[ "$(id -u)" = "0" ] || { echo "run as root"; exit 1; }
[ "$(uname -s)" = "Linux" ] || { echo "Linux only"; exit 1; }

if ! command -v sshd >/dev/null || ! command -v ssh >/dev/null; then
  apt-get update -q
  DEBIAN_FRONTEND=noninteractive apt-get install -y -q openssh-client openssh-server
fi

for u in vt-agent-ana vt-agent-bo vt-checks; do
  if ! id "$u" >/dev/null 2>&1; then
    if [ "$u" = vt-checks ]; then
      # The checks user keeps nothing between runs: its home belongs to root.
      useradd --system --user-group --home-dir /var/lib/vt-checks --shell /bin/sh "$u"
      mkdir -p /var/lib/vt-checks && chown root:root /var/lib/vt-checks && chmod 755 /var/lib/vt-checks
    else
      useradd --system --user-group --create-home --home-dir "/home/$u" --shell /bin/bash "$u"
    fi
  fi
  # No password at all ("*"): key login only. ("!" would mean "locked", which sshd refuses.)
  usermod -p '*' "$u"
  [ "$u" = vt-checks ] || chmod 700 "/home/$u"
done
echo "ready: $(id vt-agent-ana) / $(id vt-agent-bo) / $(id vt-checks)"
