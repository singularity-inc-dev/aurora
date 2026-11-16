#!/usr/bin/env bash
# Audit ONE repository from a full (non-shallow) clone, with the same settings as run.sh.
#   run-one-full-clone.sh OUTDIR owner/name branch bin
# Used for a repository that run.sh's shallow clone could not audit: the guard refuses a shallow clone when the
# repository has no commits for months before its first commit in the window (it cannot tell a quiet spell from
# a truncated clone). A full clone is trusted by the guard. See the report.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"; TOOL="$(cd "$HERE/.." && pwd)"
OUT="$(cd "${1:?}" && pwd)"; name="${2:?}"; branch="${3:?}"; bin="${4:?}"
key="$(echo "$name" | tr / _)"; dir="$OUT/clones/$key"; res="$OUT/$key"; mkdir -p "$res"; rm -rf "$dir"
export COLLISION_AUDIT_UNTIL=2026-11-01 COLLISION_AUDIT_MIN_COMMITS=10
started="$(date -u +%FT%TZ)"
git clone --quiet --single-branch --branch "$branch" -- "https://github.com/$name.git" "$dir" >"$res/clone.log" 2>&1 || { echo "clone failed" >&2; exit 1; }
head="$(git -C "$dir" rev-parse HEAD)"; commits="$(git -C "$dir" rev-list --count HEAD)"
"$TOOL/collision-audit" "$dir" "$name" --days 365 --max-pairs 150 --out "$res" >"$res/audit.log" 2>&1; rc=$?
status=ok; [ $rc -eq 0 ] || status="audit-failed-$rc"
printf '{"name":"%s","bin":"%s","branch":"%s","head":"%s","commitsInClone":%s,"cloneSince":"full clone","started":"%s","finished":"%s","status":"%s","git":"%s","python":"%s","note":"full clone: the shallow-since clone was refused by the truncated-clone guard"}\n' \
  "$name" "$bin" "$branch" "$head" "$commits" "$started" "$(date -u +%FT%TZ)" "$status" "$(git --version | cut -d' ' -f3)" "$(python3 -c 'import platform;print(platform.python_version())')" >"$res/manifest.json"
echo "$status: $name ($bin)"; rm -rf "$dir"
