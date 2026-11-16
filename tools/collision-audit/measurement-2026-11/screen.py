"""Step 3 of the selection: team size and activity of the candidates judged "product", in draw order.

    python3 -I screen.py pool.json judgements-*.json LOG.json [WORKDIR]

For each candidate (in the fixed draw order, only those judged "yes") it makes a commits-only bare clone of
the last ~13 months, counts non-bot authors on the default branch in the window, and decides:
  active   : at least 100 non-merge commits in the window and a commit on or after LAST_COMMIT_AFTER
  core     : authors with at least 10 commits in the window (the research's definition of core team)
  bin      : 2-3, 5-6, 7-10 or 11-30 core people (4 is not in the requested bins, so it is never picked)
It accepts a candidate into its bin while that bin has fewer than PER_BIN, and stops when all bins are full.
Nothing here replays, merges or reads any file: no audit result exists when the list is chosen.
"""
import collections
import datetime
import glob
import json
import os
import re
import shutil
import subprocess
import sys

HERE = os.path.dirname(os.path.realpath(__file__))
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.join(HERE, ".."))
import _audit  # noqa: E402
import draw  # noqa: E402

WINDOW_START = "2025-11-01"
WINDOW_END = "2026-11-01"
CLONE_SINCE = "2025-10-02"          # 30 days before the window: the buffer the audit clones keep too
LAST_COMMIT_AFTER = "2026-09-02"    # a commit in the 60 days before the window ends
MIN_COMMITS = 100
CORE_MIN_COMMITS = 10
PER_BIN = 5
BINS = [("2-3", 2, 3), ("5-6", 5, 6), ("7-10", 7, 10), ("11-30", 11, 30)]


# Added after the second pass (see the report): one person under several e-mail addresses counts once
# (identities are merged by lower-case display name), and names of translation services, coding agents and
# robots are not people. Decided from author names only.
AUTOMATION = re.compile(r"weblate|codex|claude|copilot|robot|maintenance|patcher|crowdin|transifex|dependabot|renovate|github-actions|\bbot\b|\[bot\]|\(bot\)", re.I)


def bin_of(core):
    for name, lo, hi in BINS:
        if lo <= core <= hi:
            return name
    return None


def measure(name, branch, work):
    d = os.path.join(work, name.replace("/", "__"))
    shutil.rmtree(d, ignore_errors=True)
    p = subprocess.run(
        ["git", "clone", "--quiet", "--bare", "--filter=tree:0", "--single-branch", "--branch", branch,
         "--shallow-since=" + CLONE_SINCE, "--", "https://github.com/%s.git" % name, d],
        stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=dict(os.environ, GIT_TERMINAL_PROMPT="0"), timeout=900)
    if p.returncode != 0:
        return {"error": "clone failed: " + p.stderr.decode()[-200:]}
    out = subprocess.run(
        ["git", "-C", d, "log", branch, "--no-merges", "--use-mailmap", "--since=%sT00:00:00+00:00" % WINDOW_START,
         "--until=%sT00:00:00+00:00" % WINDOW_END, "--format=%aE%x1f%aN%x1f%cI"],
        stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=600).stdout.decode("utf-8", "replace")
    rows = [l.split("\x1f") for l in out.split("\n") if l]
    counts = collections.Counter()
    names = {}
    last = ""
    for email, an, cd in rows:
        last = max(last, cd[:10])
        if _audit.is_bot(email.lower(), an) or AUTOMATION.search(an):
            continue
        counts[an.strip().lower()] += 1
        names[an.strip().lower()] = an
    shutil.rmtree(d, ignore_errors=True)
    core = [e for e, c in counts.items() if c >= CORE_MIN_COMMITS]
    return {"commits": len(rows), "nonBotCommits": sum(counts.values()), "lastCommit": last, "authors": len(counts),
            "core": len(core), "topAuthors": [[names[e], c] for e, c in counts.most_common(12)]}


def main(argv):
    pool = {r["name"]: r for r in json.load(open(argv[1]))}
    yes = set()
    for f in sorted(glob.glob(argv[2])):
        yes |= set(json.load(open(f))["yes"])
    log_path = argv[3]
    work = argv[4] if len(argv) > 4 else "/tmp/screen-work"
    os.makedirs(work, exist_ok=True)
    log = json.load(open(log_path)) if os.path.exists(log_path) else {"candidates": []}
    done = {c["name"] for c in log["candidates"]}
    filled = collections.Counter(c["bin"] for c in log["candidates"] if c.get("accepted"))
    for r in draw.ordered(list(pool.values())):
        if r["name"] not in yes or r["name"] in done:
            continue
        if all(filled[b[0]] >= PER_BIN for b in BINS):
            break
        m = measure(r["name"], r["defaultBranch"], work)
        c = {"name": r["name"], "defaultBranch": r["defaultBranch"], "stars": r["stars"], "description": r["description"], "sizeKB": r["sizeKB"]}
        c.update(m)
        if "error" in m:
            c.update(accepted=False, reason=m["error"])
        elif m["nonBotCommits"] < MIN_COMMITS:
            c.update(accepted=False, reason="fewer than %d commits in the window" % MIN_COMMITS)
        elif m["lastCommit"] < LAST_COMMIT_AFTER:
            c.update(accepted=False, reason="no commit since %s" % LAST_COMMIT_AFTER)
        else:
            b = bin_of(m["core"])
            c["bin"] = b
            if b is None:
                c.update(accepted=False, reason="%d core people: outside 2-30 or exactly 4" % m["core"])
            elif filled[b] >= PER_BIN:
                c.update(accepted=False, reason="bin %s already full" % b)
            else:
                c.update(accepted=True, reason="accepted into bin %s" % b)
                filled[b] += 1
        log["candidates"].append(c)
        json.dump(log, open(log_path, "w"), indent=1)
        print("%-45s core=%-3s commits=%-5s last=%s -> %s" % (c["name"], m.get("core"), m.get("nonBotCommits"), m.get("lastCommit"), c["reason"]), flush=True)
    print("bins:", dict(filled))


if __name__ == "__main__":
    main(sys.argv)
