"""Step 1: same-day changes by two people to the same code file.

    python3 -I measure_overlap.py repos overlap.json owner/name

Reads the default branch's history in the window below. Read-only; sends nothing.
"""
import collections
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.realpath(__file__)))
import _audit  # noqa: E402

# The time window: the last WINDOW_DAYS days (the playbook uses 90).
WINDOW_DAYS = int(os.environ.get("COLLISION_AUDIT_DAYS", "90"))
# People column: distinct non-bot authors with at least this many commits in the window.
PEOPLE_MIN_COMMITS = int(os.environ.get("COLLISION_AUDIT_MIN_COMMITS", "3"))


def main(argv):
    if len(argv) != 4:
        _audit.fail("usage: measure_overlap.py repos overlap.json owner/name")
    _, repos, out, name = argv
    repo = _audit.repo_path(repos, name)
    since, until = _audit.window(WINDOW_DAYS)
    _audit.check_history_depth(repo, since)
    rows = _audit.commits(repo, since, until)
    overlaps = _audit.same_day_overlaps(rows)
    commit_counts = collections.Counter(
        email for _, email, n, _, _ in rows if not _audit.is_bot(email, n)
    )
    people = {email for email, cnt in commit_counts.items() if cnt >= PEOPLE_MIN_COMMITS}
    code_files = {f for *_, files in rows for f in files if _audit.is_code(f)}
    top = collections.Counter(o["file"] for o in overlaps).most_common(10)
    weeks = WINDOW_DAYS / 7.0
    _audit.write_json(out, {
        "repo": name,
        "window": {"since": since.isoformat(), "until": until.isoformat(), "days": WINDOW_DAYS},
        "commits": len(rows),
        "people": len(people),
        "peopleMinCommits": PEOPLE_MIN_COMMITS,
        "codeFilesChanged": len(code_files),
        "overlaps": overlaps,
        "overlapsPerWeek": round(len(overlaps) / weeks, 2),
        "topFiles": top,
    })
    print("%s: %d commits by %d people (≥%d commits); %d same-day overlaps on code files (%.2f a week)" % (name, len(rows), len(people), PEOPLE_MIN_COMMITS, len(overlaps), len(overlaps) / weeks))


if __name__ == "__main__":
    main(sys.argv)
