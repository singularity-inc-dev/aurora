"""Step 2: replay each overlap as if the two changes had been made in parallel.

    python3 -I replay_pairs_v2.py repos pairs.jsonl 60 owner/name

60 is the most overlaps to replay (an even sample when there are more).
For each pair: the earlier change A is replayed on its own parent (the base), the
later change B is moved onto the same base on its own, and git merges the two
(`git merge-tree --write-tree`). If B cannot be moved onto the base cleanly (it
built on work in between), the replay is not clean and is not counted.
Everything git writes goes into a temporary object folder; the clone is untouched.
"""
import os
import shutil
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.realpath(__file__)))
import _audit  # noqa: E402


def sample(items, n):
    if len(items) <= n:
        return list(items)
    step = len(items) / float(n)
    return [items[int(i * step)] for i in range(n)]


def parent(repo, sha, env):
    code, out = _audit.git(repo, ["rev-parse", "--verify", "--quiet", "%s^1" % sha], env, ok=(0, 1))
    return out.strip() if code == 0 else None


def is_ancestor(repo, a, b, env):
    code, _ = _audit.git(repo, ["merge-base", "--is-ancestor", a, b], env, ok=(0, 1))
    return code == 0


def merge_tree(repo, base, ours, theirs, env):
    """(conflicted?, tree, files) of merging theirs into ours over base, in memory."""
    code, out = _audit.git(repo, ["merge-tree", "--write-tree", "--name-only", "--no-messages", "-z", "--merge-base=%s" % base, ours, theirs], env, ok=(0, 1))
    parts = [p for p in out.split("\0") if p]
    if not parts or not _audit.SHA.match(parts[0].strip()):
        raise RuntimeError("merge-tree gave no tree")
    return code == 1, parts[0].strip(), sorted(set(parts[1:]))


def replay(repo, o, env):
    a, b = o["a"]["commit"], o["b"]["commit"]
    if not (_audit.SHA.match(a) and _audit.SHA.match(b)):
        return {"status": "error", "reason": "not a commit id"}
    # The earlier change is A: an ancestor first, otherwise the older commit.
    if is_ancestor(repo, b, a, env):
        a, b = b, a
    elif not is_ancestor(repo, a, b, env):
        _, ta = _audit.git(repo, ["show", "-s", "--format=%ct", a], env)
        _, tb = _audit.git(repo, ["show", "-s", "--format=%ct", b], env)
        if int(tb) < int(ta):
            a, b = b, a
    base, b_parent = parent(repo, a, env), parent(repo, b, env)
    if not base or not b_parent:
        return {"status": "not-replayable", "reason": "a first commit has no parent"}
    moved_conflict, b_tree, _ = merge_tree(repo, b_parent, base, b, env)
    if moved_conflict:
        return {"status": "not-replayable", "reason": "the later change built on work in between", "earlier": a, "later": b}
    _, b_moved = _audit.git(repo, ["commit-tree", b_tree, "-p", base, "-m", "replayed"], dict(env, GIT_AUTHOR_NAME="audit", GIT_AUTHOR_EMAIL="audit@localhost", GIT_COMMITTER_NAME="audit", GIT_COMMITTER_EMAIL="audit@localhost"))
    conflicted, _, files = merge_tree(repo, base, a, b_moved.strip(), env)
    # The pair is about one file: it conflicts when that file does. Other files are kept for reading.
    others = [f for f in files if f != o["file"]] if conflicted else []
    if conflicted and o["file"] in files:
        return {"status": "conflict", "files": [o["file"]], "otherConflictFiles": others, "earlier": a, "later": b, "base": base}
    return {"status": "clean", "otherConflictFiles": others, "earlier": a, "later": b, "base": base}


def main(argv):
    if len(argv) != 5:
        _audit.fail("usage: replay_pairs_v2.py repos pairs.jsonl MAX_PAIRS owner/name")
    _, repos, out, max_pairs, name = argv
    _audit.check_git_version()
    repo = _audit.repo_path(repos, name)
    overlap_file = os.path.join(os.path.dirname(os.path.abspath(out)), "overlap.json")
    if not os.path.exists(overlap_file):
        _audit.fail("run measure_overlap.py first (it writes overlap.json next to %s)" % out)
    overlap = _audit.read_json(overlap_file)
    _, objects = _audit.git(repo, ["rev-parse", "--path-format=absolute", "--git-path", "objects"])
    scratch = tempfile.mkdtemp(prefix="collision-audit-")
    env = {"GIT_OBJECT_DIRECTORY": scratch, "GIT_ALTERNATE_OBJECT_DIRECTORIES": objects.strip()}
    rows = []
    try:
        for o in sample(overlap["overlaps"], int(max_pairs)):
            try:
                r = replay(repo, o, env)
            except RuntimeError as e:
                r = {"status": "error", "reason": str(e)}
            rows.append(dict(o, repo=name, **r))
    finally:
        shutil.rmtree(scratch, ignore_errors=True)
    _audit.write_jsonl(out, rows)
    counts = {}
    for r in rows:
        counts[r["status"]] = counts.get(r["status"], 0) + 1
    print("%s: replayed %d of %d overlaps: %s" % (name, len(rows), len(overlap["overlaps"]), ", ".join("%s %d" % kv for kv in sorted(counts.items())) or "none"))


if __name__ == "__main__":
    main(sys.argv)
