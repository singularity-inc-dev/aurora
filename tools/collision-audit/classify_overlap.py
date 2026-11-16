"""Step 3: classify each replayed pair.

    python3 -I classify_overlap.py repos pairs.jsonl classified.jsonl

"follow-up": the later change edits lines the earlier change wrote (git blame
says so), so it was not separate work. "independent": separate work on the same
file. Only clean replays (status conflict or clean) are classified. Read-only.
"""
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.realpath(__file__)))
import _audit  # noqa: E402

HUNK = re.compile(r"^@@ -(\d+)(?:,(\d+))? \+\d+(?:,\d+)? @@")


def changed_old_lines(repo, later, path):
    """Line ranges of the file before `later` that `later` removes or changes."""
    _, out = _audit.git(repo, ["diff", "-U0", "--no-color", "--no-ext-diff", "--no-textconv", "%s^1" % later, later, "--", path])
    ranges = []
    for line in out.split("\n"):
        m = HUNK.match(line)
        if m:
            start, count = int(m.group(1)), int(m.group(2) if m.group(2) is not None else 1)
            if count > 0:
                ranges.append((start, start + count - 1))
    return ranges


def written_by(repo, later, path, ranges, earlier):
    for start, end in ranges:
        code, out = _audit.git(repo, ["blame", "--porcelain", "-L", "%d,%d" % (start, end), "%s^1" % later, "--", path], ok=(0, 128))
        if code != 0:
            continue
        for line in out.split("\n"):
            if line[:40] == earlier[:40] and _audit.SHA.match(line.split(" ")[0]):
                return True
    return False


def main(argv):
    if len(argv) != 4:
        _audit.fail("usage: classify_overlap.py repos pairs.jsonl classified.jsonl")
    _, repos, pairs_file, out = argv
    rows = []
    for p in _audit.read_jsonl(pairs_file):
        if p.get("status") not in ("conflict", "clean"):
            continue
        repo = _audit.repo_path(repos, p["repo"])
        earlier, later = p["earlier"], p["later"]
        follow_up = written_by(repo, later, p["file"], changed_old_lines(repo, later, p["file"]), earlier)
        rows.append(dict(p, relation="follow-up" if follow_up else "independent"))
    _audit.write_jsonl(out, rows)
    independent = sum(1 for r in rows if r["relation"] == "independent")
    print("classified %d clean replays: %d independent, %d follow-ups" % (len(rows), independent, len(rows) - independent))


if __name__ == "__main__":
    main(sys.argv)
