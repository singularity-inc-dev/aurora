"""Shareable one-page report for a collision-audit workdir.

    python3 -I report.py WORKDIR [--show-paths]

Reads overlap.json, rates.json and weekly.json from WORKDIR and writes
report.md and report.html. File paths are hidden by default so a team
can share the report safely; author names are never included.
"""
import argparse
import html as _html
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.realpath(__file__)))
import _audit  # noqa: E402

_BOLD = re.compile(r"\*\*([^*]+)\*\*")
_CODE = re.compile(r"`([^`]+)`")


def _num(x):
    if x is None:
        return "n/a"
    s = "%.2f" % x
    return s.rstrip("0").rstrip(".")


def render_md(overlap, rates, weekly, show_paths=False):
    repo = overlap["repo"]
    w = overlap["window"]
    would = weekly.get("wouldBeConflictsPerWeek") or {}
    hd = weekly.get("handoverDays", 3)

    lines = [
        "# Collision audit: %s" % repo,
        "",
        "**Window:** %s to %s (%d days)  " % (w["since"][:10], w["until"][:10], w["days"]),
        "**Active people (≥%d commits):** %d  " % (overlap.get("peopleMinCommits", 3), overlap["people"]),
        "**Commits:** %d" % overlap["commits"],
        "",
        "| Measure | Per week |",
        "| --- | --- |",
        "| Overlaps (two people, same code file, same day) | %s |" % _num(overlap.get("overlapsPerWeek")),
        "| Would-be conflicts at today's pace | %s |" % _num(would.get("sameDay")),
        "| Would-be conflicts at %d-day handover cadence | %s |" % (hd, _num(would.get("threeDay"))),
        "",
        "**Method:** History-based: replays human commits on the default branch. "
        "Agent commits are not included.",
        "",
        "**Limits:** Counts textual git conflicts only; merges that succeed but break "
        "behaviour are not detected. This is a historical rate for humans, not a "
        "measured agent conflict rate.",
    ]

    if show_paths and overlap.get("topFiles"):
        lines += [
            "",
            "## Files with most overlaps",
            "",
        ]
        lines += ["- `%s`: %d" % (f, n) for f, n in overlap["topFiles"]]

    return "\n".join(lines) + "\n"


def _esc(s):
    return _html.escape(str(s))


def _inline(s):
    s = _esc(s)
    s = _BOLD.sub(r"<strong>\1</strong>", s)
    s = _CODE.sub(r"<code>\1</code>", s)
    return s


def render_html(overlap, rates, weekly, show_paths=False):
    repo = overlap["repo"]
    w = overlap["window"]
    would = weekly.get("wouldBeConflictsPerWeek") or {}
    hd = weekly.get("handoverDays", 3)

    def tr(label, value):
        return "<tr><td>%s</td><td>%s</td></tr>" % (_esc(label), _esc(value))

    table_rows = "\n".join([
        tr("Overlaps (two people, same code file, same day)", _num(overlap.get("overlapsPerWeek")) + " per week"),
        tr("Would-be conflicts at today's pace", _num(would.get("sameDay")) + " per week"),
        tr("Would-be conflicts at %d-day handover cadence" % hd, _num(would.get("threeDay")) + " per week"),
    ])

    top_files = ""
    if show_paths and overlap.get("topFiles"):
        items = "\n".join("<li><code>%s</code>: %d</li>" % (_esc(f), n) for f, n in overlap["topFiles"])
        top_files = "<h2>Files with most overlaps</h2>\n<ul>\n%s\n</ul>" % items

    return """<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Collision audit: %s</title>
<style>
body{font-family:system-ui,sans-serif;max-width:720px;margin:2rem auto;padding:0 1rem;color:#1a1a1a;line-height:1.5}
h1{font-size:1.4rem;margin-bottom:.3rem}
h2{font-size:1.1rem;margin-top:1.5rem}
table{border-collapse:collapse;width:100%%;margin:1rem 0}
th,td{border:1px solid #d0d0d0;padding:.45rem .75rem;text-align:left}
th{background:#f5f5f5}
p{margin:.6rem 0}
code{background:#f0f0f0;padding:.1em .3em;border-radius:3px;font-size:.9em}
ul{line-height:1.7}
.meta{color:#555;font-size:.95em;margin:.2rem 0}
</style>
</head>
<body>
<h1>Collision audit: %s</h1>
<p class="meta"><strong>Window:</strong> %s to %s (%d days) &nbsp;|&nbsp;
<strong>Active people (≥%d commits):</strong> %d &nbsp;|&nbsp;
<strong>Commits:</strong> %d</p>
<table>
<tr><th>Measure</th><th>Per week</th></tr>
%s
</table>
<p><strong>Method:</strong> History-based: replays human commits on the default branch.
Agent commits are not included.</p>
<p><strong>Limits:</strong> Counts textual git conflicts only; merges that succeed but break
behaviour are not detected. This is a historical rate for humans, not a measured agent
conflict rate.</p>
%s
</body>
</html>
""" % (
        _esc(repo), _esc(repo),
        _esc(w["since"][:10]), _esc(w["until"][:10]), w["days"],
        overlap.get("peopleMinCommits", 3), overlap["people"], overlap["commits"],
        table_rows,
        top_files,
    )


def main(argv):
    p = argparse.ArgumentParser(
        description="Write a shareable report from a collision-audit workdir.")
    p.add_argument("workdir")
    p.add_argument("--show-paths", action="store_true",
                   help="Include top file paths in the report")
    args = p.parse_args(argv[1:])

    d = args.workdir
    overlap = _audit.read_json(os.path.join(d, "overlap.json"))
    rates = _audit.read_json(os.path.join(d, "rates.json"))
    weekly = _audit.read_json(os.path.join(d, "weekly.json"))

    md = render_md(overlap, rates, weekly, show_paths=args.show_paths)
    with open(os.path.join(d, "report.md"), "w", encoding="utf-8") as f:
        f.write(md)

    html_content = render_html(overlap, rates, weekly, show_paths=args.show_paths)
    with open(os.path.join(d, "report.html"), "w", encoding="utf-8") as f:
        f.write(html_content)

    print(md)
    sys.stderr.write("report.md and report.html written to %s\n" % d)


if __name__ == "__main__":
    main(sys.argv)
