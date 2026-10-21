#!/usr/bin/env bash
# Cloud environment setup script: Node 24.11+ (via nvm) and pnpm 9.15+.
# Needs outbound access to: raw.githubusercontent.com, github.com, nodejs.org, registry.npmjs.org
set -euo pipefail

export NVM_DIR="$HOME/.nvm"
if [ ! -s "$NVM_DIR/nvm.sh" ]; then
  curl -fsSo- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
fi
. "$NVM_DIR/nvm.sh"

nvm install 24
nvm alias default 24

# Make new shells pick up nvm (the installer normally does this; keep it idempotent).
grep -q 'NVM_DIR' "$HOME/.bashrc" 2>/dev/null || cat >> "$HOME/.bashrc" <<'RC'
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
RC

npm install -g pnpm@10.28.0

node -v
pnpm -v
git --version
