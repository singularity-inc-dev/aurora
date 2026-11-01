import { describe, expect, it } from "vitest";
import { compare, formatSeconds, renderReport, signTest, summarize, type Arm, type RunRecord, type Verdict } from "../src/replayeval.js";

let seq = 0;
function run(taskId: string, arm: Arm, verdict: Verdict, agentSeconds: number | null = 60, repeat = 1): RunRecord {
  seq += 1;
  return { taskId, arm, repeat, verdict, agentSeconds, checkSeconds: 5, detail: verdict === "failed" ? `tests failed (${seq})` : "ok", failedChecks: verdict === "failed" ? ["tests"] : [] };
}
/** Pairs of verdicts, one task each: [baseline, candidate]. */
function pairs(...list: Array<[Verdict, Verdict]>): RunRecord[] {
  return list.flatMap(([b, c], i) => [run(`t${i}`, "baseline", b), run(`t${i}`, "candidate", c)]);
}
const many = (n: number, p: [Verdict, Verdict]) => Array.from({ length: n }, () => p);

describe("sign test", () => {
  it("is exact", () => {
    expect(signTest(0, 0)).toBeNull();
    expect(signTest(6, 0)).toBeCloseTo(0.03125, 6);
    expect(signTest(5, 0)).toBeCloseTo(0.0625, 6);
    expect(signTest(0, 6)).toBeCloseTo(0.03125, 6);
    expect(signTest(3, 3)).toBe(1);
    expect(signTest(8, 1)).toBeCloseTo(0.0391, 3);
    expect(signTest(7, 1)).toBeCloseTo(0.0703, 3);
  });
});

describe("summarize", () => {
  it("counts each verdict, the pass rate and the median time", () => {
    const s = summarize([run("a", "baseline", "passed", 10), run("b", "baseline", "failed", 30), run("c", "baseline", "not-tested", 20), run("d", "baseline", "no-changes", null), run("e", "baseline", "agent-error", 40)]);
    expect(s).toMatchObject({ runs: 5, passed: 1, failed: 1, notTested: 1, noChanges: 1, agentError: 1, passRate: 0.2, medianAgentSeconds: 25 });
    expect(s.totalSeconds).toBe(10 + 30 + 20 + 40 + 5 * 5);
  });
  it("handles no runs at all", () => {
    expect(summarize([])).toMatchObject({ runs: 0, passRate: null, medianAgentSeconds: null, totalSeconds: 0 });
  });
});

describe("compare", () => {
  it("says the candidate is better only when the sign test is below 5%", () => {
    const c = compare(pairs(...many(6, ["failed", "passed"]), ...many(6, ["passed", "passed"])));
    expect(c.candidateOnly).toHaveLength(6);
    expect(c.baselineOnly).toHaveLength(0);
    expect(c.bothPassed).toBe(6);
    expect(c.signTestP).toBeCloseTo(0.03125, 5);
    expect(c.conclusion).toMatch(/^The candidate is better/);
  });

  it("says the candidate is worse when the baseline wins clearly", () => {
    const c = compare(pairs(...many(7, ["passed", "failed"]), ...many(5, ["failed", "failed"])));
    expect(c.conclusion).toMatch(/^The candidate is worse/);
    expect(c.neitherPassed).toBe(5);
  });

  it("refuses to call five wins out of five a difference, and says how big a gap has to be", () => {
    const c = compare(pairs(...many(5, ["failed", "passed"]), ...many(7, ["passed", "passed"])));
    expect(c.signTestP).toBeCloseTo(0.0625, 5);
    expect(c.conclusion).toMatch(/^Cannot tell/);
    expect(c.conclusion).toContain("at least 6 tasks");
  });

  it("says the prompts did the same when nothing differs", () => {
    const c = compare(pairs(...many(6, ["passed", "passed"]), ...many(6, ["failed", "failed"])));
    expect(c.signTestP).toBeNull();
    expect(c.conclusion).toMatch(/^No task changed/);
  });

  it("never counts NOT TESTED, nothing committed or an agent error as a pass", () => {
    const c = compare(pairs(["not-tested", "passed"], ["no-changes", "passed"], ["agent-error", "passed"], ["failed", "passed"], ["passed", "passed"]));
    expect(c.baseline.passed).toBe(1);
    expect(c.candidateOnly).toHaveLength(4);
    expect(c.warnings.join(" ")).toContain("NOT TESTED");
    expect(c.warnings.join(" ")).toContain("agent error");
  });

  it("with repeats, a task passes when more than half of its runs passed", () => {
    const runs = [
      ...["passed", "passed", "failed"].map((v, i) => run("t", "baseline", v as Verdict, 10, i + 1)),
      ...["passed", "failed", "failed"].map((v, i) => run("t", "candidate", v as Verdict, 10, i + 1)),
    ];
    const c = compare(runs);
    expect(c.baselineOnly).toEqual(["t"]);
    expect(c.baseline.runs).toBe(3);
  });

  it("an exact tie in repeats is not a pass", () => {
    const runs = [run("t", "baseline", "passed", 1, 1), run("t", "baseline", "failed", 1, 2), run("t", "candidate", "passed", 1, 1), run("t", "candidate", "passed", 1, 2)];
    expect(compare(runs).candidateOnly).toEqual(["t"]);
  });

  it("warns when fewer than 10 tasks were replayed and when each ran once", () => {
    const c = compare(pairs(["passed", "passed"], ["failed", "passed"]));
    expect(c.warnings[0]).toContain("Only 2 tasks");
    expect(c.warnings.join(" ")).toContain("ran once per prompt");
    const full = compare(pairs(...many(10, ["passed", "passed"])));
    expect(full.warnings.join(" ")).not.toContain("Only");
  });

  it("reports the time ratio without letting it into the verdict", () => {
    const runs = [run("a", "baseline", "passed", 100), run("a", "candidate", "passed", 50)];
    const c = compare(runs);
    expect(c.timeRatio).toBe(0.5);
    expect(c.conclusion).not.toMatch(/time|faster/i);
  });

  it("copes with a task that has runs for only one prompt", () => {
    const c = compare([run("a", "baseline", "passed")]);
    expect(c.tasks).toBe(1);
    expect(c.baselineOnly).toEqual(["a"]);
    expect(c.candidate.runs).toBe(0);
    expect(c.timeRatio).toBeNull();
  });
});

describe("formatSeconds", () => {
  it("reads naturally", () => {
    expect([null, 12, 89.6, 150, 3700].map(formatSeconds)).toEqual(["n/a", "12s", "1m 30s", "2m 30s", "1h 1m"]);
  });
});

describe("report", () => {
  const labels = [
    { taskId: "t0", identifier: "VT-1", title: "Add a greeting | with a pipe", originalChecks: "passed", originalOutcome: "accepted" },
    { taskId: "t1", identifier: "VT-2", title: "Fix the thing", originalChecks: "failed", originalOutcome: "rejected" },
  ];
  const runs = pairs(["passed", "failed"], ["failed", "failed"]);
  const text = renderReport({ runs, labels, skipped: [{ taskId: "t9", identifier: "VT-9", reason: "commit not in this repository" }], baselineName: "base.md", candidateName: "cand.md", gate: "tests `pnpm test`, diff limit 400 lines", generatedAt: new Date("2026-11-01T12:00:00Z") });

  it("states that tests decide and names both prompts and the gate", () => {
    expect(text).toContain("Decided by tests only. No AI judge.");
    expect(text).toContain("`base.md`");
    expect(text).toContain("`cand.md`");
    expect(text).toContain("tests `pnpm test`");
  });
  it("has the counts the owner asked for: passed, not tested, failed, time", () => {
    for (const w of ["| Passed |", "| Not tested |", "| Failed |", "| Median agent time |", "| Total time (agent + checks) |"]) expect(text).toContain(w);
  });
  it("lists tasks, escapes table pipes, and says why runs failed and what was skipped", () => {
    expect(text).toContain("VT-1 Add a greeting \\| with a pipe");
    expect(text).toContain("accepted, checks passed");
    expect(text).toContain("## Why runs did not pass");
    expect(text).toContain("VT-9: commit not in this repository");
  });
  it("shows the conclusion in bold", () => {
    expect(text).toMatch(/\*\*(Cannot tell|The candidate|No task changed)/);
  });
  it("never contains agent output markers or a description field", () => {
    expect(text).not.toMatch(/stdout|stderr/i);
  });
});
