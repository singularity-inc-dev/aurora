import { describe, expect, it } from "vitest";
import { COUNT_KEYS, computeCounts, type CountsInput } from "../src/counts.js";
import { EVENT_LOG_HEADER, eventLogCsv } from "../src/eventlogcsv.js";

const ev = (task_id: string, owner: string, extra: Record<string, unknown> = {}) => ({ task_id, owner, agent: `agent-${owner}`, task_kind: "task", ...extra });
const items = (...pairs: Array<[string, string]>) => JSON.stringify(pairs.map(([taskId, category]) => ({ taskId, category })));
const shared = (taskId: string, withTaskId: string, withOwner: string) => JSON.stringify([{ taskId, withTaskId, withOwner, files: ["a.ts"] }]);

const input: CountsInput = {
  events: [
    ev("a1", "ana", { approved_at: "2026-10-21T22:00:00Z", checks_result: "passed", outcome: "accepted" }),
    ev("a2", "ana", { approved_at: "2026-10-21T22:00:00Z", checks_result: "failed", outcome: "blocked" }),
    ev("a3", "ana", { approved_at: "2026-10-21T22:00:00Z", checks_result: "not-tested", outcome: null }),
    ev("a4", "ana", { approved_at: "2026-10-21T22:00:00Z", outcome: "failed" }),
    ev("a5", "ana", { outcome: "rejected", reject_reason: "plan rejected" }),
    ev("b1", "bo", { approved_at: "2026-10-21T22:00:00Z", checks_result: "passed", outcome: "rejected", reject_reason: "wrong" }),
    ev("b2", "bo", { task_kind: "handoff", approved_at: null }),
  ],
  flags: new Map([
    ["a2", [{ kind: "tool-error" as const, detail: "run_checks: x" }]],
    ["a4", [{ kind: "timeout" as const, detail: "after 2 tries" }]],
    ["a3", [{ kind: "budget-stop" as const, detail: null }]],
  ]),
  briefings: [
    { owner: "ana", items: items(["a1", "ready"], ["a3", "ready"], ["a2", "blocked"]), shared_files: shared("a1", "b1", "bo") },
    // a1 listed Ready again in a later (carried) email: still one ready task.
    { owner: "ana", items: items(["a1", "ready"]), shared_files: "[]" },
    { owner: "bo", items: items(["b1", "ready"]), shared_files: shared("b1", "a1", "ana") }, // the same pair seen from Bo's side
  ],
  conflicts: [{ task_a: "a3", task_b: "b1", owner_a: "ana", owner_b: "bo" }],
};

describe("computeCounts", () => {
  const n = computeCounts(input);
  const ana = n.people.find((p) => p.owner === "ana")!;
  const bo = n.people.find((p) => p.owner === "bo")!;

  it("counts handed over, ready, approved, rejected, failed and not tested per person", () => {
    expect(ana.all).toMatchObject({ handedOver: 4, ready: 2, approved: 1, rejected: 1, failed: 1, notTested: 1 });
    expect(bo.all).toMatchObject({ handedOver: 1, ready: 1, approved: 0, rejected: 1, failed: 0, notTested: 0 });
  });

  it("counts a pair of teammates' tasks once, even when both emails or both views list it", () => {
    // a1/b1 overlap cleanly (listed in two emails); a3/b1 do not merge.
    expect(n.team).toMatchObject({ teammateOverlaps: 2, wouldBeConflicts: 1 });
    expect(ana.all).toMatchObject({ teammateOverlaps: 2, wouldBeConflicts: 1 });
    expect(bo.all).toMatchObject({ teammateOverlaps: 2, wouldBeConflicts: 1 });
  });

  it("does not count two of one person's own tasks as teammates", () => {
    const own = computeCounts({ ...input, briefings: [{ owner: "ana", items: "[]", shared_files: shared("a1", "a2", "ana") }], conflicts: [] });
    expect(own.team).toMatchObject({ teammateOverlaps: 0, wouldBeConflicts: 0 });
  });

  it("splits by task kind", () => {
    expect(bo.kinds.map((k) => k.kind)).toEqual(["handoff", "task"]);
    expect(bo.kinds.find((k) => k.kind === "handoff")!.counts).toMatchObject({ handedOver: 0, rejected: 0 });
    expect(bo.kinds.find((k) => k.kind === "task")!.counts).toMatchObject({ handedOver: 1, rejected: 1, teammateOverlaps: 2 });
  });

  it("counts run flags: tool errors, failed checks, timeouts, budget stops", () => {
    expect(n.team).toMatchObject({ toolErrors: 1, checksFailed: 1, timedOut: 1, budgetStops: 1 });
  });

  it("the team row is the sum of the tasks, with each pair counted once", () => {
    expect(n.team).toMatchObject({ handedOver: 5, ready: 3, approved: 1, rejected: 2, failed: 1, notTested: 1 });
    for (const key of COUNT_KEYS.filter((k) => k !== "teammateOverlaps" && k !== "wouldBeConflicts")) {
      expect(n.team[key]).toBe(n.people.reduce((sum, p) => sum + p.all[key], 0));
    }
  });

  it("only ever holds whole numbers: no percentage, rate or average", () => {
    const every = [n.team, ...n.people.flatMap((p) => [p.all, ...p.kinds.map((k) => k.counts)])];
    for (const counts of every) {
      expect(Object.keys(counts).sort()).toEqual([...COUNT_KEYS].sort());
      for (const v of Object.values(counts)) expect(Number.isInteger(v)).toBe(true);
    }
    expect(JSON.stringify(n)).not.toMatch(/yield|percent|rate|average|median/i);
  });

  it("an empty log is all zeros", () => {
    const empty = computeCounts({ events: [], flags: new Map(), briefings: [], conflicts: [] });
    expect(empty.people).toEqual([]);
    expect(Object.values(empty.team).every((v) => v === 0)).toBe(true);
  });

  it("survives broken JSON in a briefing row", () => {
    expect(() => computeCounts({ ...input, briefings: [{ owner: "ana", items: "{nope", shared_files: "also nope" }] })).not.toThrow();
  });
});

describe("eventLogCsv", () => {
  const csv = eventLogCsv(
    [
      ev("t2", "bo", { proposed_at: "2026-10-22T10:00:00Z", outcome: "rejected", reject_reason: '=HYPERLINK("x"), "bad"' }),
      ev("t1", "ana", { proposed_at: "2026-10-21T10:00:00Z", approved_at: "2026-10-21T11:00:00Z", checks_result: "failed", handed_off_to: "bo" }),
      ev("t3", "ana", { proposed_at: new Date("2026-10-23T10:00:00Z"), checks_result: "passed" }),
    ],
    new Map([["t1", [{ kind: "timeout" as const, detail: "after 2 tries" }]]]),
  )
    .trimEnd()
    .split("\r\n");

  it("has the event-log columns from CLAUDE.md, then the run flags", () => {
    expect(csv[0]).toBe(EVENT_LOG_HEADER.join(","));
    expect(EVENT_LOG_HEADER.slice(0, 12)).toEqual([
      "task id", "owner", "agent", "task kind", "proposed at", "approved at", "started at", "finished at", "checks result", "outcome", "reject reason", "handed off to",
    ]);
  });

  it("is one row per task, oldest first, with flags (stored and read from the log)", () => {
    expect(csv).toHaveLength(4);
    expect(csv[1]).toBe("t1,ana,agent-ana,task,2026-10-21T10:00:00Z,2026-10-21T11:00:00Z,,,failed,,,bo,checks-failed;timeout,timeout: after 2 tries");
    expect(csv[3]).toContain("2026-10-23T10:00:00.000Z"); // a Date from the database becomes ISO text
  });

  it("keeps a reject reason from running as a spreadsheet formula", () => {
    // The reason column starts with an apostrophe; the flag-details column starts with the kind, so it cannot be a formula.
    expect(csv[2]).toBe(
      't2,bo,agent-bo,task,2026-10-22T10:00:00Z,,,,,rejected,"\'=HYPERLINK(""x""), ""bad""",,rejected,"rejected: =HYPERLINK(""x""), ""bad"""',
    );
  });
});
