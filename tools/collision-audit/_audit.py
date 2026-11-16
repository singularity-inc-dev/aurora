"""Shared helpers for the collision-audit scripts (pilot playbook, week 0).

Read-only and offline: git runs with no global or system config, with every
remote protocol refused, and anything a replay writes goes to a temporary object
folder, never into the team's repository. Python 3.9+ standard library only.
"""
import datetime
import json
import math
import os
import re
import subprocess
import sys
import tempfile

REPO_NAME = re.compile(r"^[A-Za-z0-9._-]+/[A-Za-z0-9._-]+$")
SHA = re.compile(r"^[0-9a-f]{40}([0-9a-f]{24})?$")

# Source code, by extension. Docs, data, lock files, images and generated files are not code.
CODE_EXTENSIONS = {
    ".c", ".cc", ".cpp", ".cs", ".css", ".dart", ".ex", ".exs", ".go", ".h", ".hpp", ".html", ".java",
    ".js", ".jsx", ".kt", ".kts", ".less", ".lua", ".m", ".mjs", ".cjs", ".php", ".py", ".rb", ".rs",
    ".scala", ".scss", ".sh", ".sql", ".svelte", ".swift", ".ts", ".tsx", ".vue", ".zig", ".graphql",
    ".proto", ".tf", ".ipynb", ".r", ".jl", ".clj", ".erl", ".hs", ".ml", ".fs", ".vb",
}
NOT_CODE_PARTS = ("node_modules/", "vendor/", "dist/", "build/", "third_party/", "__generated__/", ".min.")


def fail(message):
    sys.stderr.write("collision-audit: %s\n" % message)
    sys.exit(2)


def repo_path(repos, name):
    """repos/owner__name, as the playbook says to clone it."""
    if not REPO_NAME.match(name):
        fail("repository must be given as owner/name, got %r" % name)
    path = os.path.join(repos, name.replace("/", "__"))
    if not os.path.isdir(path):
        fail("no clone at %s (clone the repository there as owner__name)" % path)
    return os.path.abspath(path)


def git_env(extra=None):
    env = {
        "PATH": os.environ.get("PATH", "/usr/bin:/bin"),
        "HOME": tempfile.gettempdir(),
        "LANG": "C",
        "LC_ALL": "C",
        "GIT_CONFIG_NOSYSTEM": "1",
        "GIT_CONFIG_GLOBAL": os.devnull,
        "GIT_TERMINAL_PROMPT": "0",
        # Sends nothing: no protocol is allowed, so git cannot reach any remote.
        "GIT_ALLOW_PROTOCOL": "none",
        "GIT_OPTIONAL_LOCKS": "0",
    }
    if extra:
        env.update(extra)
    return env


def git(repo, args, env=None, ok=(0,)):
    """Run git without a shell. Returns (exit code, stdout)."""
    p = subprocess.run(
        ["git", "-c", "core.quotePath=false", "-c", "core.fsmonitor=false", "-C", repo] + list(args),
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        env=git_env(env),
    )
    if p.returncode not in ok:
        raise RuntimeError("git %s failed (%d)" % (args[0], p.returncode))
    return p.returncode, p.stdout.decode("utf-8", "replace")


def check_git_version():
    p = subprocess.run(["git", "--version"], stdout=subprocess.PIPE, env=git_env())
    m = re.search(r"(\d+)\.(\d+)", p.stdout.decode())
    if not m or (int(m.group(1)), int(m.group(2))) < (2, 38):
        fail("git 2.38 or newer is needed (for git merge-tree --write-tree)")


def is_code(path):
    if any(part in path for part in NOT_CODE_PARTS):
        return False
    return os.path.splitext(path)[1].lower() in CODE_EXTENSIONS


def is_bot(email, name):
    e, n = email.lower(), name.lower()
    return "[bot]" in n or "[bot]" in e or e.startswith("bot@") or "-bot@" in e or n.endswith(" bot")


def window(days, until=None):
    end = until or datetime.datetime.now(datetime.timezone.utc)
    return end - datetime.timedelta(days=days), end


def commits(repo, since, until):
    """Non-merge commits on the default branch in the window, newest first:
    (sha, author email, author name, author day in the author's own time zone, files)."""
    _, out = git(repo, [
        "log", "HEAD", "--no-merges", "--use-mailmap", "--no-renames",
        "--since=%s" % since.isoformat(), "--until=%s" % until.isoformat(),
        "--format=%x1e%H%x1f%aE%x1f%aN%x1f%aI", "--name-only",
    ])
    result = []
    for block in out.split("\x1e")[1:]:
        head, _, files = block.partition("\n")
        sha, email, name, date = head.split("\x1f")
        result.append((sha, email.strip().lower(), name.strip(), date[:10], [f for f in files.split("\n") if f]))
    return result


def same_day_overlaps(rows, bucket=None):
    """Two different people changing the same code file in the same bucket (by default: the same day).
    One entry per (bucket, file, pair of people), with each person's latest commit there."""
    bucket = bucket or (lambda day: day)
    latest = {}  # (bucket, file, author) -> (sha, day); rows are newest first
    for sha, email, name, day, files in rows:
        if is_bot(email, name):
            continue
        for f in files:
            if is_code(f):
                latest.setdefault((bucket(day), f, email), (sha, day))
    by_place = {}
    for (b, f, email), (sha, day) in latest.items():
        by_place.setdefault((b, f), []).append((email, sha, day))
    overlaps = []
    for (b, f), people in sorted(by_place.items()):
        people.sort()
        for i in range(len(people)):
            for j in range(i + 1, len(people)):
                (ea, sa, da), (eb, sb, db) = people[i], people[j]
                overlaps.append({"day": min(da, db), "bucket": b, "file": f, "a": {"author": ea, "commit": sa}, "b": {"author": eb, "commit": sb}})
    return overlaps


def check_history_depth(repo, since):
    """Refuse if the clone is shallow and does not cover the window start.

    A shallow clone cut off inside the window silently understates counts.
    This fails fast with the exact re-clone command needed to fix it.
    """
    _, shallow = git(repo, ["rev-parse", "--is-shallow-repository"], ok=(0, 1))
    if shallow.strip() != "true":
        return  # full clone (or git too old to report it): trust it
    # Any commit before the window start means the history covers the window.
    _, pre = git(repo, [
        "log", "HEAD", "--format=%H",
        "--before=%s" % since.isoformat(),
        "--max-count=1",
    ])
    if pre.strip():
        return
    # No commit before the window start: check the actual oldest commit's
    # author date.  A clone made with --shallow-since=WINDOW_START has no
    # commits before that date (that is the definition of --shallow-since),
    # but if its oldest commit is dated on or before the window start the
    # clone covers the full window and should be accepted.
    #
    # NOTE: --max-count applies before --reverse, so --reverse --max-count=1
    # returns the newest commit.  Read all dates, take the first line after
    # reversing.
    _, all_dates = git(repo, [
        "log", "HEAD", "--no-merges", "--format=%aI", "--reverse",
    ])
    oldest_date = all_dates.strip().split("\n")[0][:10] if all_dates.strip() else "unknown"
    if oldest_date != "unknown" and oldest_date <= since.isoformat()[:10]:
        return  # shallow-since set to window start; clone covers the window
    fail(
        "shallow clone is truncated: oldest commit (%s) is inside the window "
        "(window starts %s); re-clone with:\n"
        "  git clone --shallow-since=%s -- <url> <dir>"
        % (oldest_date, since.isoformat()[:10], since.isoformat()[:10])
    )


def wilson(k, n, z=1.96):
    """95% Wilson interval for k successes out of n."""
    if n == 0:
        return None
    p = k / n
    d = 1 + z * z / n
    c = (p + z * z / (2 * n)) / d
    h = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / d
    return [max(0.0, c - h), min(1.0, c + h)]


def read_json(path):
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def read_jsonl(path):
    with open(path, encoding="utf-8") as f:
        return [json.loads(line) for line in f if line.strip()]


def write_json(path, data):
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2, sort_keys=True)
        f.write("\n")


def write_jsonl(path, rows):
    with open(path, "w", encoding="utf-8") as f:
        for r in rows:
            f.write(json.dumps(r, sort_keys=True) + "\n")
