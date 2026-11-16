#!/usr/bin/env bash
# The 2026-11 collision measurement: audit the 20 repositories in repos.tsv over a fixed 365-day window.
#
#   tools/collision-audit/measurement-2026-11/run.sh OUTDIR [JOBS]
#
# For each repository: a shallow clone from 30 days before the window (so the truncated-clone guard sees a
# commit before the window start), then tools/collision-audit/collision-audit with
#   COLLISION_AUDIT_UNTIL=2026-11-01  COLLISION_AUDIT_MIN_COMMITS=10  --days 365  --max-pairs 150
# Each repository gets OUTDIR/<owner>_<name>/ (the audit's own files) and manifest.json (the clone's head
# commit, the date it was cloned, tool versions). The clone is deleted after its audit (it can be fetched
# again; see the report). A failed repository is recorded as failed and never dropped.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TOOL="$(cd "$HERE/.." && pwd)"
OUT="${1:?usage: run.sh OUTDIR [JOBS]}"; JOBS="${2:-3}"
mkdir -p "$OUT/clones" && OUT="$(cd "$OUT" && pwd)"
export UNTIL=2026-11-01 DAYS=365 MAX_PAIRS=150 CLONE_SINCE=2025-10-02 TOOL OUT
export COLLISION_AUDIT_UNTIL=2026-11-01 COLLISION_AUDIT_MIN_COMMITS=10

one() {
  name="$1"; branch="$2"; bin="$3"
  key="$(echo "$name" | tr / _)"; dir="$OUT/clones/$key"; res="$OUT/$key"
  mkdir -p "$res"
  started="$(date -u +%FT%TZ)"
  if ! git clone --quiet --single-branch --branch "$branch" --shallow-since="$CLONE_SINCE" -- "https://github.com/$name.git" "$dir" >"$res/clone.log" 2>&1; then
    echo "FAILED (clone): $name" >&2
    printf '{"name":"%s","bin":"%s","status":"clone-failed","started":"%s"}\n' "$name" "$bin" "$started" >"$res/manifest.json"
    return 0
  fi
  head="$(git -C "$dir" rev-parse HEAD)"; commits="$(git -C "$dir" rev-list --count HEAD)"
  "$TOOL/collision-audit" "$dir" "$name" --days "$DAYS" --max-pairs "$MAX_PAIRS" --out "$res" >"$res/audit.log" 2>&1
  rc=$?
  status=ok; [ $rc -eq 0 ] || status="audit-failed-$rc"
  printf '{"name":"%s","bin":"%s","branch":"%s","head":"%s","commitsInClone":%s,"cloneSince":"%s","started":"%s","finished":"%s","status":"%s","git":"%s","python":"%s"}\n' \
    "$name" "$bin" "$branch" "$head" "$commits" "$CLONE_SINCE" "$started" "$(date -u +%FT%TZ)" "$status" "$(git --version | cut -d' ' -f3)" "$(python3 -c 'import platform;print(platform.python_version())')" >"$res/manifest.json"
  echo "$status: $name ($bin)" >&2
  rm -rf "$dir"
}
export -f one

grep -v '^#' "$HERE/repos.tsv" | while IFS=$'\t' read -r name branch bin; do printf '%s\0%s\0%s\0' "$name" "$branch" "$bin"; done \
  | xargs -0 -n3 -P "$JOBS" bash -c 'one "$0" "$1" "$2"'
echo "done: $(ls "$OUT"/*/manifest.json | wc -l) manifests in $OUT" >&2
