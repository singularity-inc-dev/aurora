#!/usr/bin/env bash
# How old is each repository's history inside the window? (Added after the run started; see the report.)
#   age.sh OUT.tsv
# Commit-only bare clone from 2025-10-02. "complete" = the clone holds the whole history (no older commits
# exist, so the repository is younger than that date); "cut-off" = older history exists. The oldest author
# date in the clone is the start of activity unless it is within a few days of the clone date.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"; OUT="${1:?usage: age.sh OUT.tsv}"; W="$(mktemp -d)"
printf 'bin\tname\toldest_author_date_in_clone\thistory\n' > "$OUT"
while IFS=$'\t' read -r n b bin; do
  d="$W/$(echo "$n" | tr / _)"
  git clone -q --bare --filter=tree:0 --single-branch --branch "$b" --shallow-since=2025-10-02 -- "https://github.com/$n.git" "$d" 2>/dev/null
  if [ -f "$d/shallow" ]; then h=cut-off; else h=complete; fi
  printf '%s\t%s\t%s\t%s\n' "$bin" "$n" "$(git -C "$d" log --format=%as "$b" | tail -1)" "$h" >> "$OUT"
  rm -rf "$d"
done < "$HERE/repos.tsv"
rmdir "$W"
