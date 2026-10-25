"""The one-page summary for the team (playbook week 0, step 6).

    python3 -I summary.py WORKDIR

Reads overlap.json, rates.json and weekly.json from WORKDIR and writes summary.md.
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.realpath(__file__)))
import _audit  # noqa: E402


def pct(x):
    return "n/a" if x is None else "%d%%" % round(100 * x)


def num(x):
    return "n/a" if x is None else ("%.2f" % x).rstrip("0").rstrip(".")


def render(overlap, rates, weekly):
    i = rates["independent"]
    rate_line = "%s of independent pairs (%d of %d; 95%% interval %s to %s)" % (
        pct(i["rate"]), i["conflicts"], i["pairs"], pct((i["interval95"] or [None])[0]), pct((i["interval95"] or [None, None])[1])
    ) if i["pairs"] else "%s of all clean replays (%d of %d; no independent pairs)" % (pct(rates["all"]["rate"]), rates["all"]["conflicts"], rates["all"]["pairs"]) if rates["all"]["pairs"] else "no overlaps could be replayed"
    would = weekly.get("wouldBeConflictsPerWeek") or {}
    today = would.get("sameDay")
    lines = [
        "# Collision audit: %s" % overlap["repo"],
        "",
        "The last %d days of the default branch (%s to %s): %d commits by %d people. Read-only; nothing was sent anywhere." % (
            overlap["window"]["days"], overlap["window"]["since"][:10], overlap["window"]["until"][:10], overlap["commits"], overlap["people"]),
        "",
        "| Measure | Result |",
        "| --- | --- |",
        "| Overlaps a week (two people, same code file, same day) | %s |" % num(overlap["overlapsPerWeek"]),
        "| Conflict rate if that work had been done in parallel | %s |" % rate_line,
        "| Would-be conflicts a week, at today's pace | %s |" % num(today),
        "| Would-be conflicts a week, at %d days of work per handover | %s |" % (weekly["handoverDays"], num(would.get("threeDay"))),
        "| Would-be conflicts a week, at three times today's pace | %s |" % num(None if today is None else today * 3),
        "",
        "## Files where most overlaps happened",
        "",
    ]
    lines += ["- `%s`: %d" % (f, n) for f, n in overlap["topFiles"]] or ["- none"]
    lines += [
        "",
        "## How to read this",
        "",
        "- An overlap is two different people changing the same code file on the same day. Each one was replayed with git's own merge as if the two changes had been made in parallel; %d of %d replays were clean enough to count." % (rates["cleanReplays"], rates["replayed"]),
        "- \"Independent\" pairs are separate pieces of work; a follow-up (the second change edits lines the first one wrote) is not counted in the rate.",
        "- Only textual conflicts are counted: merges that succeed but break behaviour are missed. Read a sample of the flagged pairs in `pairs.jsonl` (status \"conflict\") before trusting the number.",
        "- If this team would hit fewer than one conflict a week even at three times its pace, choose a busier team or repository.",
    ]
    return "\n".join(lines) + "\n"


def main(argv):
    if len(argv) != 2:
        _audit.fail("usage: summary.py WORKDIR")
    d = argv[1]
    text = render(_audit.read_json(os.path.join(d, "overlap.json")), _audit.read_json(os.path.join(d, "rates.json")), _audit.read_json(os.path.join(d, "weekly.json")))
    with open(os.path.join(d, "summary.md"), "w", encoding="utf-8") as f:
        f.write(text)
    print(text)


if __name__ == "__main__":
    main(sys.argv)
