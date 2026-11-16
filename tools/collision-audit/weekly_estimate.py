"""Step 5: overlaps week by week, at today's pace and at three days of work per handover.

    python3 -I weekly_estimate.py repos weekly.json owner/name [classified.jsonl]

"Three days of work per handover": two people changing the same code file within
the same three-day stretch would land in the same handover. With classified.jsonl
it also estimates would-be conflicts a week for both.
"""
import datetime
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.realpath(__file__)))
import _audit  # noqa: E402
import conflict_rates  # noqa: E402

WINDOW_DAYS = int(os.environ.get("COLLISION_AUDIT_DAYS", "90"))
HANDOVER_DAYS = 3


def week_of(day):
    d = datetime.date.fromisoformat(day)
    return (d - datetime.timedelta(days=d.weekday())).isoformat()


def main(argv):
    if len(argv) not in (4, 5):
        _audit.fail("usage: weekly_estimate.py repos weekly.json owner/name [classified.jsonl]")
    repos, out, name = argv[1], argv[2], argv[3]
    repo = _audit.repo_path(repos, name)
    since, until = _audit.window(WINDOW_DAYS)
    rows = _audit.commits(repo, since, until)
    start = since.date()

    def stretch(day):
        return (datetime.date.fromisoformat(day) - start).days // HANDOVER_DAYS

    same_day = _audit.same_day_overlaps(rows)
    three_day = _audit.same_day_overlaps(rows, bucket=stretch)
    weeks = {}
    for o in same_day:
        weeks.setdefault(week_of(o["day"]), [0, 0])[0] += 1
    for o in three_day:
        first = (start + datetime.timedelta(days=o["bucket"] * HANDOVER_DAYS)).isoformat()
        weeks.setdefault(week_of(first), [0, 0])[1] += 1
    n_weeks = WINDOW_DAYS / 7.0
    result = {
        "repo": name,
        "windowDays": WINDOW_DAYS,
        "handoverDays": HANDOVER_DAYS,
        "weeks": [{"week": w, "sameDay": c[0], "threeDay": c[1]} for w, c in sorted(weeks.items())],
        "perWeek": {"sameDay": round(len(same_day) / n_weeks, 2), "threeDay": round(len(three_day) / n_weeks, 2)},
    }
    if len(argv) == 5:
        classified = _audit.read_jsonl(argv[4])
        independent = [r for r in classified if r["relation"] == "independent"]
        r = conflict_rates.rate(independent or classified)["rate"]
        result["rate"] = r
        result["wouldBeConflictsPerWeek"] = None if r is None else {k: round(v * r, 2) for k, v in result["perWeek"].items()}
    _audit.write_json(out, result)
    print("%s: overlaps a week %.2f same-day, %.2f within %d days" % (name, result["perWeek"]["sameDay"], result["perWeek"]["threeDay"], HANDOVER_DAYS))
    if result.get("wouldBeConflictsPerWeek"):
        w = result["wouldBeConflictsPerWeek"]
        print("  would-be conflicts a week: %.2f at today's pace, %.2f at %d days of work per handover" % (w["sameDay"], w["threeDay"], HANDOVER_DAYS))


if __name__ == "__main__":
    main(sys.argv)
