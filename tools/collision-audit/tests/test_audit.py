"""Tests for the collision audit. Run: python3 -I tools/collision-audit/tests/test_audit.py"""
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
import unittest

HERE = os.path.dirname(os.path.realpath(__file__))
TOOL = os.path.dirname(HERE)
sys.path.insert(0, TOOL)
import _audit  # noqa: E402
import classify_overlap  # noqa: E402
import replay_pairs_v2  # noqa: E402
import report  # noqa: E402
import batch_summary  # noqa: E402

DAY = 86400


class Repo:
    """A made-up team repository with dated commits by Ana, Bo, Cy and a bot."""

    def __init__(self, path):
        self.path = path
        self.now = int(time.time())
        self.git("init", "-q", "-b", "main")

    def git(self, *args, when=None, who=("Ana", "ana@example.com")):
        env = dict(os.environ, GIT_CONFIG_GLOBAL=os.devnull, GIT_CONFIG_NOSYSTEM="1",
                   GIT_AUTHOR_NAME=who[0], GIT_AUTHOR_EMAIL=who[1], GIT_COMMITTER_NAME=who[0], GIT_COMMITTER_EMAIL=who[1])
        if when is not None:
            env["GIT_AUTHOR_DATE"] = env["GIT_COMMITTER_DATE"] = "@%d +0000" % when
        return subprocess.run(["git", "-C", self.path] + list(args), env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE).stdout.decode().strip()

    def write(self, name, lines):
        with open(os.path.join(self.path, name), "w") as f:
            f.write("\n".join(lines) + "\n")

    def commit(self, who, when, message, files):
        for name, lines in files.items():
            self.write(name, lines)
        self.git("add", "-A")
        self.git("commit", "-qm", message, when=when, who=who)
        return self.git("rev-parse", "HEAD")


ANA, BO, CY, BOT = ("Ana", "ana@example.com"), ("Bo", "bo@example.com"), ("Cy", "cy@example.com"), ("dependabot[bot]", "bot@example.com")
APP = ["line %d" % i for i in range(1, 21)]


def with_line(lines, n, text):
    out = list(lines)
    out[n - 1] = text
    return out


def build(path):
    r = Repo(path)
    d = r.now - 10 * DAY  # "day D": ten days ago, at midday UTC
    d = d - d % DAY + 12 * 3600
    r.commit(ANA, r.now - 100 * DAY, "old", {"app.py": APP, "lib.py": ["a", "b", "c"], "README.md": ["hi"]})
    base = r.git("rev-parse", "HEAD")
    r.commit(BO, r.now - 100 * DAY + 60, "old overlap, outside the window", {"app.py": with_line(APP, 1, "old bo")})
    base = r.git("rev-parse", "HEAD")
    # Three branches from the same base, all on day D.
    r.git("checkout", "-q", "-b", "x", base)
    a = r.commit(ANA, d, "ana: line 5", {"app.py": with_line(with_line(APP, 1, "old bo"), 5, "ana's line 5"), "README.md": ["ana"]})
    r.git("checkout", "-q", "-b", "y", base)
    b = r.commit(BO, d + 3600, "bo: line 5", {"app.py": with_line(with_line(APP, 1, "old bo"), 5, "bo's line 5"), "README.md": ["bo"]})
    r.git("checkout", "-q", "-b", "z", base)
    c = r.commit(CY, d + 7200, "cy: line 18", {"app.py": with_line(with_line(APP, 1, "old bo"), 18, "cy's line 18")})
    r.git("checkout", "-q", "-b", "w", base)
    r.commit(BOT, d + 7300, "bot bump", {"app.py": with_line(with_line(APP, 1, "old bo"), 10, "bot")})
    r.git("checkout", "-q", "main")
    r.git("merge", "-q", "--no-ff", "-m", "merge x", "x", when=d + 8000)
    r.git("merge", "-q", "--no-ff", "-m", "merge y", "y", when=d + 8100)  # conflicts: resolve by hand
    r.write("app.py", with_line(with_line(APP, 1, "old bo"), 5, "ana and bo's line 5"))
    r.write("README.md", ["ana and bo"])
    r.git("add", "-A")
    r.git("commit", "-qm", "merge y", when=d + 8200)
    r.git("merge", "-q", "--no-ff", "-m", "merge z", "z", when=d + 8300)
    r.git("merge", "-q", "--no-ff", "-m", "merge w", "w", when=d + 8400)
    # Day D+1: Bo edits lines Ana has just written (a follow-up, on main).
    r.commit(ANA, d + DAY, "ana: lib", {"lib.py": ["ana 1", "ana 2", "c"]})
    r.commit(BO, d + DAY + 600, "bo: fix ana's lib lines", {"lib.py": ["bo 1", "ana 2", "c"]})
    # Extra commits so each of ANA, BO, CY reaches the ≥3-commit threshold.
    # Different files / different days: no new same-day overlaps introduced.
    r.commit(ANA, d + 2 * DAY, "ana: notes", {"notes.py": ["note 1"]})
    r.commit(BO, d + 3 * DAY, "bo: notes", {"notes.py": ["note 2"]})
    r.commit(CY, d + 3 * DAY + 3600, "cy: util", {"util.py": ["util 1"]})
    r.commit(CY, d + 4 * DAY, "cy: util v2", {"util.py": ["util 2"]})
    return r, a, b, c


def snapshot(path):
    """Everything the audit must leave alone: refs, the index, files and objects."""
    git = lambda *a: subprocess.run(["git", "-C", path] + list(a), stdout=subprocess.PIPE).stdout
    objects = sorted(os.path.join(dp, f) for dp, _, fs in os.walk(os.path.join(path, ".git", "objects")) for f in fs)
    return (git("for-each-ref"), git("status", "--porcelain"), git("rev-parse", "HEAD"), git("ls-files", "-s"), objects)


class AuditTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.mkdtemp(prefix="collision-audit-test-")
        cls.clone = os.path.join(cls.tmp, "team-app")
        os.mkdir(cls.clone)
        cls.repo, cls.a, cls.b, cls.c = build(cls.clone)
        cls.before = snapshot(cls.clone)
        cls.out = os.path.join(cls.tmp, "out")
        p = subprocess.run([os.path.join(TOOL, "collision-audit"), cls.clone, "acme/app", "--out", cls.out], stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
        cls.log = p.stdout.decode()
        assert p.returncode == 0, cls.log
        cls.after = snapshot(cls.clone)
        load = lambda n: json.load(open(os.path.join(cls.out, n)))
        cls.overlap, cls.rates, cls.weekly = load("overlap.json"), load("rates.json"), load("weekly.json")
        cls.pairs = _audit.read_jsonl(os.path.join(cls.out, "pairs.jsonl"))

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.tmp, ignore_errors=True)

    def test_finds_same_day_overlaps_on_code_files_only(self):
        found = sorted((o["file"], o["a"]["author"], o["b"]["author"]) for o in self.overlap["overlaps"])
        self.assertEqual(found, [
            ("app.py", "ana@example.com", "bo@example.com"),
            ("app.py", "ana@example.com", "cy@example.com"),
            ("app.py", "bo@example.com", "cy@example.com"),
            ("lib.py", "ana@example.com", "bo@example.com"),
        ])  # no README (not code), no bot, nothing older than the window
        self.assertEqual(self.overlap["people"], 3)
        self.assertEqual(self.overlap["overlapsPerWeek"], round(4 / (90 / 7.0), 2))
        self.assertEqual(self.overlap["topFiles"][0], ["app.py", 3])

    def test_replays_as_if_in_parallel(self):
        by = {(p["a"]["author"][:2], p["b"]["author"][:2], p["file"]): p["status"] for p in self.pairs}
        self.assertEqual(by[("an", "bo", "app.py")], "conflict")
        self.assertEqual(by[("an", "cy", "app.py")], "clean")
        self.assertEqual(by[("bo", "cy", "app.py")], "clean")
        # Bo's follow-up edits Ana's new lines: it cannot be moved onto her base, so it is not counted.
        self.assertEqual(by[("an", "bo", "lib.py")], "not-replayable")
        conflict = [p for p in self.pairs if p["status"] == "conflict"][0]
        self.assertEqual(conflict["files"], ["app.py"])

    def test_rates_and_would_be_conflicts(self):
        self.assertEqual(self.rates["independent"]["pairs"], 3)
        self.assertEqual(self.rates["independent"]["conflicts"], 1)
        self.assertEqual(self.rates["independent"]["rate"], 0.333)
        lo, hi = self.rates["independent"]["interval95"]
        self.assertTrue(0 < lo < 0.333 < hi < 1)
        self.assertEqual(self.rates["wouldBeConflictsPerWeek"], round(self.overlap["overlapsPerWeek"] * 0.333, 2))

    def test_weekly_estimate_at_three_days_per_handover(self):
        self.assertGreaterEqual(self.weekly["perWeek"]["threeDay"], self.weekly["perWeek"]["sameDay"])
        self.assertEqual(sum(w["sameDay"] for w in self.weekly["weeks"]), 4)
        self.assertIn("wouldBeConflictsPerWeek", self.weekly)

    def test_summary_for_the_team(self):
        text = open(os.path.join(self.out, "summary.md")).read()
        self.assertIn("# Collision audit: acme/app", text)
        self.assertIn("| Conflict rate if that work had been done in parallel | 33% of independent pairs (1 of 3;", text)
        self.assertIn("- `app.py`: 3", text)
        self.assertIn("nothing was sent anywhere", text)

    def test_the_clone_is_not_changed(self):
        self.assertEqual(self.before, self.after)

    def test_sends_nothing(self):
        # No network code in any script, and git may not use any remote protocol.
        for name in os.listdir(TOOL):
            if name.endswith(".py") or name == "collision-audit":
                src = open(os.path.join(TOOL, name)).read()
                self.assertIsNone(re.search(r"\b(socket|urllib|http\.client|requests|curl|wget|ssh|ftplib|smtplib)\b", src), name)
        with self.assertRaises(RuntimeError):
            _audit.git(self.clone, ["ls-remote", "https://example.com/acme/app.git"])

    def test_classifier_marks_follow_ups(self):
        # Forced through as if it had been replayable: Bo's lib.py change edits Ana's lines.
        rows = [p for p in self.pairs if p["file"] == "lib.py"]
        ana, bo = rows[0]["a"]["commit"], rows[0]["b"]["commit"]
        ranges = classify_overlap.changed_old_lines(self.clone, bo, "lib.py")
        self.assertTrue(classify_overlap.written_by(self.clone, bo, "lib.py", ranges, ana))
        ranges = classify_overlap.changed_old_lines(self.clone, self.c, "app.py")
        self.assertFalse(classify_overlap.written_by(self.clone, self.c, "app.py", ranges, self.a))

    def test_refuses_bad_input(self):
        with self.assertRaises(SystemExit):
            _audit.repo_path(self.out, "../etc")
        self.assertEqual(replay_pairs_v2.replay(self.clone, {"a": {"commit": "--help"}, "b": {"commit": self.b}}, {})["status"], "error")

    def test_report_md_hides_paths_by_default(self):
        overlap = self.overlap
        rates = self.rates
        weekly = self.weekly
        md = report.render_md(overlap, rates, weekly, show_paths=False)
        self.assertIn("# Collision audit: acme/app", md)
        self.assertIn("Active people (≥3 commits):", md)
        self.assertIn("Method:", md)
        self.assertIn("Limits:", md)
        self.assertIn("historical rate for humans", md)
        self.assertNotIn("app.py", md)  # paths hidden

    def test_report_md_shows_paths_when_requested(self):
        md = report.render_md(self.overlap, self.rates, self.weekly, show_paths=True)
        self.assertIn("app.py", md)

    def test_report_html_is_valid_and_self_contained(self):
        html = report.render_html(self.overlap, self.rates, self.weekly, show_paths=False)
        self.assertIn("<!doctype html>", html)
        self.assertIn("acme/app", html)
        self.assertIn("<table>", html)
        # No external scripts or stylesheets
        self.assertNotIn("src=", html)
        self.assertNotIn("href=", html)
        # No file paths in default mode
        self.assertNotIn("app.py", html)

    def test_report_html_shows_paths_when_requested(self):
        html = report.render_html(self.overlap, self.rates, self.weekly, show_paths=True)
        self.assertIn("app.py", html)

    def test_report_script_writes_files(self):
        report.main(["report.py", self.out])
        self.assertTrue(os.path.exists(os.path.join(self.out, "report.md")))
        self.assertTrue(os.path.exists(os.path.join(self.out, "report.html")))
        md_text = open(os.path.join(self.out, "report.md")).read()
        self.assertIn("# Collision audit:", md_text)
        html_text = open(os.path.join(self.out, "report.html")).read()
        self.assertIn("<!doctype html>", html_text)

    def test_batch_summary_table(self):
        import io
        # Build a fake batch dir with one workdir
        batch_dir = os.path.join(self.tmp, "batch")
        workdir = os.path.join(batch_dir, "acme_app")
        os.makedirs(workdir)
        for name in ("overlap.json", "rates.json", "weekly.json"):
            src = os.path.join(self.out, name)
            import shutil as _shutil
            _shutil.copy(src, workdir)
        table = batch_summary.render(batch_dir, ["acme/app"])
        self.assertIn("acme/app", table)
        self.assertIn("People (≥3c)", table)
        # No percentages in the table
        self.assertNotIn("%", table)

    def test_batch_summary_missing_repo_shows_failed(self):
        batch_dir = os.path.join(self.tmp, "batch2")
        os.makedirs(batch_dir)
        table = batch_summary.render(batch_dir, ["missing/repo"])
        self.assertIn("FAILED", table)

    def test_collision_audit_report_flag(self):
        out2 = os.path.join(self.tmp, "out-report")
        p = subprocess.run(
            [os.path.join(TOOL, "collision-audit"), self.clone, "acme/app", "--out", out2, "--report"],
            stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
        )
        self.assertEqual(p.returncode, 0, p.stdout.decode())
        self.assertTrue(os.path.exists(os.path.join(out2, "report.md")))
        self.assertTrue(os.path.exists(os.path.join(out2, "report.html")))

    def test_sends_nothing_report_and_batch(self):
        for name in ("report.py", "batch_summary.py", "collision-audit-batch"):
            src = open(os.path.join(TOOL, name)).read()
            self.assertIsNone(
                re.search(r"\b(socket|urllib|http\.client|requests|curl|wget|ssh|ftplib|smtplib)\b", src),
                "%s contains network code" % name,
            )

    def test_refuses_shallow_clone_truncated_inside_window(self):
        """A shallow clone whose history doesn't reach the window start is refused."""
        with tempfile.TemporaryDirectory() as tmp:
            shallow = os.path.join(tmp, "shallow")
            os.mkdir(shallow)
            r = Repo(shallow)
            # One commit made 5 days ago — inside any 90-day window.
            r.commit(ANA, int(time.time()) - 5 * DAY, "recent commit", {"main.py": ["line 1"]})
            root_sha = r.git("rev-parse", "HEAD")
            # Write .git/shallow to mark this repo as shallow with no history before root.
            with open(os.path.join(shallow, ".git", "shallow"), "w") as f:
                f.write(root_sha + "\n")
            out_dir = os.path.join(tmp, "out")
            p = subprocess.run(
                [os.path.join(TOOL, "collision-audit"), shallow, "acme/test", "--out", out_dir],
                stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
            )
            self.assertNotEqual(p.returncode, 0)
            output = p.stdout.decode()
            self.assertIn("truncated", output)
            self.assertIn("shallow-since", output)

    def test_full_clone_not_refused(self):
        """A full clone (no .git/shallow) is never refused on depth grounds."""
        p = subprocess.run(
            [os.path.join(TOOL, "collision-audit"), self.clone, "acme/app", "--out",
             os.path.join(self.tmp, "out2")],
            stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
        )
        self.assertEqual(p.returncode, 0, p.stdout.decode())


if __name__ == "__main__":
    unittest.main(verbosity=1)
