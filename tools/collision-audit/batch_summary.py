"""Print a summary table for a batch collision-audit run.

    python3 -I batch_summary.py BATCHDIR NAME1 [NAME2 ...]

Reads the workdir for each name under BATCHDIR and prints a Markdown table
of raw counts (no percentages). Repos that have no workdir are listed as
failed.
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.realpath(__file__)))
import _audit  # noqa: E402


def _num(x):
    if x is None:
        return "n/a"
    s = "%.2f" % x
    return s.rstrip("0").rstrip(".")


def _load(batch_dir, name):
    d = os.path.join(batch_dir, name.replace("/", "_"))
    try:
        overlap = _audit.read_json(os.path.join(d, "overlap.json"))
        weekly = _audit.read_json(os.path.join(d, "weekly.json"))
        return overlap, weekly
    except (FileNotFoundError, KeyError):
        return None, None


def render(batch_dir, names):
    rows = []
    for name in names:
        overlap, weekly = _load(batch_dir, name)
        if overlap is None:
            rows.append((name, "FAILED", "", "", "", ""))
            continue
        w = overlap["window"]
        window = "%s – %s" % (w["since"][:10], w["until"][:10])
        people = str(overlap["people"])
        per_week = weekly.get("perWeek", {})
        would = weekly.get("wouldBeConflictsPerWeek") or {}
        rows.append((
            name,
            window,
            people,
            _num(per_week.get("sameDay")),
            _num(per_week.get("threeDay")),
            _num(would.get("threeDay")),
        ))

    header = ("Repo", "Window", "People", "Overlaps/wk (same-day)", "Overlaps/wk (3-day)", "Would-be conflicts/wk (3-day)")
    widths = [max(len(h), max(len(r[i]) for r in rows)) for i, h in enumerate(header)]

    def fmt(cells):
        return "| " + " | ".join(c.ljust(widths[i]) for i, c in enumerate(cells)) + " |"

    lines = [
        fmt(header),
        "| " + " | ".join("-" * w for w in widths) + " |",
    ]
    for r in rows:
        lines.append(fmt(r))
    return "\n".join(lines) + "\n"


def main(argv):
    if len(argv) < 3:
        _audit.fail("usage: batch_summary.py BATCHDIR NAME1 [NAME2 ...]")
    batch_dir = argv[1]
    names = argv[2:]
    table = render(batch_dir, names)
    print(table)
    # Also write it to the batch dir.
    out_path = os.path.join(batch_dir, "batch-summary.md")
    with open(out_path, "w", encoding="utf-8") as f:
        f.write("# Collision audit: batch summary\n\n")
        f.write(table)
        f.write("\n")
        f.write("**Method:** History-based: replays human commits on the default branch. "
                "Agent commits are not included.\n\n")
        f.write("**Limits:** Counts textual git conflicts only; merges that succeed but "
                "break behaviour are not detected. Historical rate for humans, not a "
                "measured agent conflict rate.\n")
    sys.stderr.write("batch-summary.md written to %s\n" % batch_dir)


if __name__ == "__main__":
    main(sys.argv)
