"""Aggregate the 20 audits by team size, exactly as fixed in the report (section 5).

    python3 -I aggregate.py RUNDIR PUBLISHDIR

Reads RUNDIR/<owner>_<name>/{overlap,rates,weekly,manifest}.json and classified.jsonl, repos.tsv and
screening-final.json (next to this file). Writes PUBLISHDIR/results.json, PUBLISHDIR/results.md and a trimmed
copy of each repository's data (e-mail addresses replaced by a short hash). Standard library only.
"""
import gzip
import hashlib
import json
import math
import os
import random
import sys

HERE = os.path.dirname(os.path.realpath(__file__))
sys.path.insert(0, os.path.join(HERE, ".."))
import _audit  # noqa: E402

WEEKS = 365 / 7.0
BOOT = 10000
SEED = 1
BIN_ORDER = ["2-3", "5-6", "7-10", "11-30"]


def pct(x):
    return "n/a" if x is None else "%.1f%%" % (100 * x)


def quantile(xs, q):
    xs = sorted(xs)
    i = q * (len(xs) - 1)
    lo, hi = int(math.floor(i)), int(math.ceil(i))
    return xs[lo] + (xs[hi] - xs[lo]) * (i - lo)


def interval(xs):
    return [quantile(xs, 0.025), quantile(xs, 0.975)]


def load_repo(run, name, bin_, screen):
    d = os.path.join(run, name.replace("/", "_"))
    r = {"name": name, "bin": bin_, "coreScreened": screen[name]["core"]}
    try:
        man = _audit.read_json(os.path.join(d, "manifest.json"))
    except (OSError, ValueError):
        man = {"status": "no-manifest"}
    r["manifest"] = man
    if man.get("status") != "ok":
        r["failed"] = man.get("status")
        return r
    overlap = _audit.read_json(os.path.join(d, "overlap.json"))
    rates = _audit.read_json(os.path.join(d, "rates.json"))
    weekly = _audit.read_json(os.path.join(d, "weekly.json"))
    classified = _audit.read_jsonl(os.path.join(d, "classified.jsonl")) if os.path.exists(os.path.join(d, "classified.jsonl")) else []
    pairs = _audit.read_jsonl(os.path.join(d, "pairs.jsonl")) if os.path.exists(os.path.join(d, "pairs.jsonl")) else []
    ind = [1 if c["status"] == "conflict" else 0 for c in classified if c["relation"] == "independent"]
    allc = [1 if c["status"] == "conflict" else 0 for c in classified]
    r.update({
        "window": overlap["window"], "commits": overlap["commits"], "peopleTool": overlap["people"],
        "overlaps": len(overlap["overlaps"]), "overlapsPerWeek": len(overlap["overlaps"]) / WEEKS,
        "threeDayPerWeek": weekly["perWeek"]["threeDay"],
        "replayed": len(pairs), "notReplayable": rates["notReplayable"],
        "cleanReplays": len(allc), "conflictsAll": sum(allc),
        "independentPairs": len(ind), "conflictsIndependent": sum(ind),
        "outcomes": ind if ind else allc, "rateBasis": "independent" if ind else ("all clean replays" if allc else "none"),
        "topFiles": overlap["topFiles"][:5],
    })
    r["conflictFiles"] = rates.get("conflictFiles", [])
    return r


def rate_of(outcomes):
    return sum(outcomes) / len(outcomes) if outcomes else None


def per_repo_conflicts(r, key, fallback):
    rate = rate_of(r["outcomes"])
    if rate is None:
        rate = fallback
    return r[key] * rate


def bootstrap(repos, fallback, n=BOOT):
    """Two-level bootstrap: resample teams, then each chosen team's replayed pairs."""
    rng = random.Random(SEED)
    out = {"overlaps": [], "same-day": [], "3-day": [], "rate": []}
    for _ in range(n):
        o, c1, c3, rates = [], [], [], []
        for _ in repos:
            r = repos[rng.randrange(len(repos))]
            outs = r["outcomes"]
            rate = (sum(outs[rng.randrange(len(outs))] for _ in outs) / len(outs)) if outs else fallback
            o.append(r["overlapsPerWeek"])
            c1.append(r["overlapsPerWeek"] * rate)
            c3.append(r["threeDayPerWeek"] * rate)
            rates.append(rate)
        k = float(len(repos))
        out["overlaps"].append(sum(o) / k)
        out["same-day"].append(sum(c1) / k)
        out["3-day"].append(sum(c3) / k)
        out["rate"].append(sum(rates) / k)
    return out


def summarize(label, repos):
    ok = [r for r in repos if "failed" not in r]
    res = {"label": label, "teams": len(repos), "teamsMeasured": len(ok), "failed": [r["name"] for r in repos if "failed" in r]}
    if not ok:
        return res
    n_all = sum(r["cleanReplays"] for r in ok)
    k_all = sum(r["conflictsAll"] for r in ok)
    n_ind = sum(r["independentPairs"] for r in ok)
    k_ind = sum(r["conflictsIndependent"] for r in ok)
    pooled_used = [o for r in ok for o in r["outcomes"]]
    fallback = rate_of(pooled_used) if pooled_used else 0.0
    res.update({
        "overlapsTotal": sum(r["overlaps"] for r in ok),
        "overlapsPerTeamWeek": sum(r["overlapsPerWeek"] for r in ok) / len(ok),
        "overlapsPerTeamWeekRange": [min(r["overlapsPerWeek"] for r in ok), max(r["overlapsPerWeek"] for r in ok)],
        "replayed": sum(r["replayed"] for r in ok), "notReplayable": sum(r["notReplayable"] for r in ok),
        "cleanReplays": n_all, "conflictsAll": k_all, "conflictsAllWilson": _audit.wilson(k_all, n_all),
        "independentPairs": n_ind, "conflictsIndependent": k_ind, "conflictsIndependentWilson": _audit.wilson(k_ind, n_ind),
        "teamsWithNoReplayablePairs": [r["name"] for r in ok if not r["outcomes"]],
        "fallbackRate": fallback,
    })
    res["conflictsPerTeamWeek"] = {
        "same-day": sum(per_repo_conflicts(r, "overlapsPerWeek", fallback) for r in ok) / len(ok),
        "3-day": sum(per_repo_conflicts(r, "threeDayPerWeek", fallback) for r in ok) / len(ok),
    }
    res["threeDayOverlapsPerTeamWeek"] = sum(r["threeDayPerWeek"] for r in ok) / len(ok)
    b = bootstrap(ok, fallback)
    res["bootstrap95"] = {k: interval(v) for k, v in b.items()}
    return res


def fmt_iv(iv, f="%.2f"):
    return "n/a" if not iv else (f + " to " + f) % tuple(iv)


def markdown(bins, five_ten, repos):
    L = []
    L.append("### Per team\n")
    L.append("| Bin | Repository | Core (screen) | People (audit, ≥10 commits) | Commits | Same-day overlaps | per week | 3-day overlaps per week | Replayed | Not replayable | Clean replays | Conflicts (all) | Independent pairs | Conflicts (independent) |")
    L.append("|---|---|---|---|---|---|---|---|---|---|---|---|---|---|")
    for r in repos:
        if "failed" in r:
            L.append("| %s | %s | %d | FAILED: %s | | | | | | | | | | |" % (r["bin"], r["name"], r["coreScreened"], r["failed"]))
            continue
        L.append("| %s | %s | %d | %d | %d | %d | %.2f | %.2f | %d | %d | %d | %d | %d | %d |" % (
            r["bin"], r["name"], r["coreScreened"], r["peopleTool"], r["commits"], r["overlaps"], r["overlapsPerWeek"], r["threeDayPerWeek"],
            r["replayed"], r["notReplayable"], r["cleanReplays"], r["conflictsAll"], r["independentPairs"], r["conflictsIndependent"]))
    L.append("\n### By team size\n")
    L.append("| Team size | Teams | Same-day overlaps per team-week (95% bootstrap; range over teams) | Clean replays | Textual conflicts (all) | Independent pairs | Conflicts (independent), pooled rate and 95% Wilson | Conflicts per team-week, today's pace (95%) | Conflicts per team-week, 3-day proxy (95%) |")
    L.append("|---|---|---|---|---|---|---|---|---|")
    for s in bins + [five_ten]:
        if not s.get("teamsMeasured"):
            L.append("| %s | %d | no data | | | | | | |" % (s["label"], s["teams"]))
            continue
        rate = s["conflictsIndependent"] / s["independentPairs"] if s["independentPairs"] else None
        b = s["bootstrap95"]
        L.append("| %s | %d | %.2f (%s; %.2f to %.2f) | %d | %d | %d | %d of %d = %s (%s to %s) | %.3f (%s) | %.3f (%s) |" % (
            s["label"], s["teamsMeasured"], s["overlapsPerTeamWeek"], fmt_iv(b["overlaps"]), s["overlapsPerTeamWeekRange"][0], s["overlapsPerTeamWeekRange"][1],
            s["cleanReplays"], s["conflictsAll"], s["independentPairs"], s["conflictsIndependent"], s["independentPairs"], pct(rate),
            pct((s["conflictsIndependentWilson"] or [None, None])[0]), pct((s["conflictsIndependentWilson"] or [None, None])[1]),
            s["conflictsPerTeamWeek"]["same-day"], fmt_iv(b["same-day"], "%.3f"), s["conflictsPerTeamWeek"]["3-day"], fmt_iv(b["3-day"], "%.3f")))
    return "\n".join(L) + "\n"


def hardy(five_ten):
    if not five_ten.get("teamsMeasured"):
        return {"answer": "no data"}
    pt = five_ten["conflictsPerTeamWeek"]["3-day"]
    lo, hi = five_ten["bootstrap95"]["3-day"]
    return {
        "pointPerTeamWeek3day": pt, "interval95": [lo, hi],
        "supportsTrigger": lo >= 1.0,
        "answer": "supports" if lo >= 1.0 else "no",
        "breakEvenMultiplierAtPoint": (1.0 / pt) if pt > 0 else None,
        "breakEvenMultiplierAtUpperBound": (1.0 / hi) if hi > 0 else None,
    }


def publish(run, out, repos):
    os.makedirs(os.path.join(out, "repos"), exist_ok=True)
    salt = "aurora-collision-2026-11"
    h = lambda e: hashlib.sha256((salt + e).encode()).hexdigest()[:8]
    for r in repos:
        key = r["name"].replace("/", "_")
        d = os.path.join(run, key)
        keep = {k: v for k, v in r.items() if k != "outcomes"}
        _audit.write_json(os.path.join(out, "repos", key + ".json"), keep)
        for name in ("rates.json", "weekly.json", "manifest.json"):
            if os.path.exists(os.path.join(d, name)):
                _audit.write_json(os.path.join(out, "repos", key + "." + name), _audit.read_json(os.path.join(d, name)))
        pj = os.path.join(d, "pairs.jsonl")
        if os.path.exists(pj):
            rows = []
            cj = os.path.join(d, "classified.jsonl")
            rel = {(c["a"]["commit"], c["b"]["commit"]): c["relation"] for c in _audit.read_jsonl(cj)} if os.path.exists(cj) else {}
            for p in _audit.read_jsonl(pj):
                p["a"] = {"author": h(p["a"]["author"]), "commit": p["a"]["commit"]}
                p["b"] = {"author": h(p["b"]["author"]), "commit": p["b"]["commit"]}
                p["relation"] = rel.get((p["a"]["commit"], p["b"]["commit"]))
                rows.append(p)
            with gzip.open(os.path.join(out, "repos", key + ".pairs.jsonl.gz"), "wt", encoding="utf-8") as f:
                for p in rows:
                    f.write(json.dumps(p, sort_keys=True) + "\n")


def main(argv):
    run, out = argv[1], argv[2]
    screen = {c["name"]: c for c in _audit.read_json(os.path.join(HERE, "screening-final.json"))["candidates"]}
    rows = [l.rstrip("\n").split("\t") for l in open(os.path.join(HERE, "repos.tsv")) if l.strip() and not l.startswith("#")]
    repos = [load_repo(run, n, b, screen) for n, br, b in rows]
    bins = [summarize(b, [r for r in repos if r["bin"] == b]) for b in BIN_ORDER]
    five_ten = summarize("5-10 (bins 5-6 and 7-10)", [r for r in repos if r["bin"] in ("5-6", "7-10")])
    verdict = hardy(five_ten)
    os.makedirs(out, exist_ok=True)
    _audit.write_json(os.path.join(out, "results.json"), {"bins": bins, "fiveToTen": five_ten, "hardy": verdict, "bootstrap": {"resamples": BOOT, "seed": SEED}})
    md = markdown(bins, five_ten, repos)
    with open(os.path.join(out, "results.md"), "w") as f:
        f.write(md)
    publish(run, out, repos)
    print(md)
    print(json.dumps(verdict, indent=1))


if __name__ == "__main__":
    main(sys.argv)
