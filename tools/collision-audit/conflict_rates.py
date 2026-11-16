"""Step 4: conflict rates and would-be conflicts a week.

    python3 -I conflict_rates.py classified.jsonl pairs.jsonl overlap.json [rates.json]

Would-be conflicts a week = same-day overlaps a week x the conflict rate of
independent pairs (all clean replays when there are no independent ones).
"""
import collections
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.realpath(__file__)))
import _audit  # noqa: E402


def rate(rows):
    n = len(rows)
    k = sum(1 for r in rows if r["status"] == "conflict")
    return {"pairs": n, "conflicts": k, "rate": round(k / n, 3) if n else None, "interval95": [round(x, 3) for x in _audit.wilson(k, n)] if n else None}


def compute(classified, pairs, overlap):
    independent = [r for r in classified if r["relation"] == "independent"]
    used = independent if independent else classified
    r = rate(used)
    per_week = overlap["overlapsPerWeek"]
    files = collections.Counter(r2["file"] for r2 in classified if r2["status"] == "conflict").most_common(10)
    return {
        "repo": overlap["repo"],
        "overlapsPerWeek": per_week,
        "replayed": len(pairs),
        "cleanReplays": len(classified),
        "notReplayable": sum(1 for p in pairs if p.get("status") == "not-replayable"),
        "all": rate(classified),
        "independent": rate(independent),
        "rateUsed": "independent" if independent else "all clean replays",
        "wouldBeConflictsPerWeek": round(per_week * r["rate"], 2) if r["rate"] is not None else None,
        "conflictFiles": files,
        "topOverlapFiles": overlap["topFiles"],
    }


def pct(x):
    return "n/a" if x is None else "%d%%" % round(100 * x)


def main(argv):
    if len(argv) not in (4, 5):
        _audit.fail("usage: conflict_rates.py classified.jsonl pairs.jsonl overlap.json [rates.json]")
    result = compute(_audit.read_jsonl(argv[1]), _audit.read_jsonl(argv[2]), _audit.read_json(argv[3]))
    if len(argv) == 5:
        _audit.write_json(argv[4], result)
    i, a = result["independent"], result["all"]
    print("%s" % result["repo"])
    print("  same-day overlaps a week: %s" % result["overlapsPerWeek"])
    print("  clean replays: %d of %d replayed (%d could not be replayed)" % (result["cleanReplays"], result["replayed"], result["notReplayable"]))
    print("  independent pairs conflicted %d of %d (%s; 95%% interval %s to %s)" % (i["conflicts"], i["pairs"], pct(i["rate"]), pct((i["interval95"] or [None])[0]), pct((i["interval95"] or [None, None])[1])))
    print("  all clean replays conflicted %d of %d (%s)" % (a["conflicts"], a["pairs"], pct(a["rate"])))
    would = result["wouldBeConflictsPerWeek"]
    print("  would-be conflicts a week at today's pace: %s (rate used: %s)" % ("n/a" if would is None else would, result["rateUsed"]))


if __name__ == "__main__":
    main(sys.argv)
