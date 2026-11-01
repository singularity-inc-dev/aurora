import { describe, expect, it } from "vitest";
import { computeNumbers, numbersCsv, type NumbersInput } from "../src/numbers.js";

// Ana: one handover with 3 work orders (one accepted, one rejected, one blocked).
// Bo: one handover with 1 work order, still undecided. Cy's plan was never approved.
const input: NumbersInput = {
  runs: [
    { owner: "ana@example.com", handover_key: "2026-10-24", task_ids: '["a1","a2","a3"]', created_at: "2026-10-24T20:00:00Z" },
    { owner: "bo@example.com", handover_key: "2026-10-24T14:05:00", task_ids: '["b1"]', created_at: "2026-10-24T14:05:00Z" },
    { owner: "cy@example.com", handover_key: "2026-10-24", task_ids: '["c1"]', created_at: "2026-10-24T20:00:00Z" },
  ],
  events: [
    { task_id: "a1", owner: "ana@example.com", proposed_at: "2026-10-24T20:10:00Z", approved_at: "2026-10-24T20:20:00Z", checks_result: "passed", outcome: "accepted" },
    { task_id: "a2", owner: "ana@example.com", proposed_at: "2026-10-24T20:10:00Z", approved_at: "2026-10-24T20:20:00Z", checks_result: "passed", outcome: "rejected" },
    { task_id: "a3", owner: "ana@example.com", proposed_at: "2026-10-24T20:10:00Z", approved_at: "2026-10-24T20:20:00Z", checks_result: null, outcome: "blocked" },
    { task_id: "b1", owner: "bo@example.com", proposed_at: "2026-10-24T14:06:00Z", approved_at: "2026-10-24T14:10:00Z", checks_result: "failed", outcome: null },
    { task_id: "c1", owner: "cy@example.com", proposed_at: "2026-10-24T20:10:00Z", approved_at: null, outcome: "rejected" },
  ],
  briefings: [
    { id: "br-a", owner: "ana@example.com", sent_at: "2026-10-25T07:00:00Z", items: '[{"rejectActionId":"x"},{"rejectActionId":"y"},{"rejectActionId":"z"}]' },
    { id: "br-b", owner: "bo@example.com", sent_at: "2026-10-24T23:00:00Z", items: '[{"rejectActionId":"w"}]' },
    { id: "br-unsent", owner: "bo@example.com", sent_at: null, items: '[{"rejectActionId":"v"}]' },
  ],
  actions: [
    { task_id: "a1", briefing_id: "br-a", state: "done", used_at: "2026-10-25T07:04:00Z" },
    { task_id: "a2", briefing_id: "br-a", state: "done", used_at: "2026-10-25T07:12:30Z" },
    { task_id: "a3", briefing_id: "br-a", state: "new", used_at: null },
  ],
  overlaps: [
    { owner: "ana@example.com", handover_key: "2026-10-24", keeper: "bo@example.com" },
    { owner: "cy@example.com", handover_key: "2026-10-24", keeper: "ana@example.com" },
  ],
  conflicts: [{ task_a: "a1", task_b: "b1", owner_a: "ana@example.com", owner_b: "bo@example.com" }],
  titles: new Map([
    ["a1", "Add greeting"],
    ["a2", "=HYPERLINK(\"http://evil\")"],
    ["a3", "Docs, part 2"],
  ]),
};

describe("numbers from the event log", () => {
  const n = computeNumbers(input);

  it("counts only work orders whose plan the owner approved", () => {
    expect(n.rows.map((r) => r.taskId)).toEqual(["a1", "a2", "a3", "b1"]);
    expect(n.team).toMatchObject({ handovers: 2, workOrders: 4, accepted: 1, rejected: 1, blocked: 1, failed: 0, undecided: 1 });
  });

  it("has no percentage or yield: only counts, and minutes", () => {
    expect(JSON.stringify(n)).not.toMatch(/yield/i);
    expect(n.team.accepted).toBe(1);
    expect(n.owners.find((o) => o.owner === "ana@example.com")!.accepted).toBe(1);
    expect(n.owners.find((o) => o.owner === "bo@example.com")!.accepted).toBe(0);
  });

  it("minutes to approve: from the email being sent to its last decision", () => {
    expect(n.rows.find((r) => r.taskId === "a1")!.minutesToApprove).toBe(4);
    expect(n.rows.find((r) => r.taskId === "a2")!.minutesToApprove).toBe(12.5);
    expect(n.rows.find((r) => r.taskId === "a3")!.minutesToApprove).toBeNull();
    const ana = n.owners.find((o) => o.owner === "ana@example.com")!;
    expect(ana.minutesToApprove).toBe(12.5);
    expect(n.owners.find((o) => o.owner === "bo@example.com")!.minutesToApprove).toBeNull();
  });

  it("decisions per handback: items needing a decision, in emails that were sent", () => {
    expect(n.owners.find((o) => o.owner === "ana@example.com")!).toMatchObject({ handbacks: 1, decisionsPerHandback: 3 });
    expect(n.team).toMatchObject({ handbacks: 2, decisionsPerHandback: 2 });
  });

  it("overlaps caught before and conflicts found after", () => {
    expect(n.team).toMatchObject({ overlapsCaughtBefore: 2, conflictsFoundAfter: 1 });
    expect(n.owners.find((o) => o.owner === "bo@example.com")!).toMatchObject({ overlapsCaughtBefore: 0, conflictsFoundAfter: 1 });
    expect(n.owners.map((o) => o.owner)).toContain("cy@example.com");
    expect(n.rows.find((r) => r.taskId === "a1")).toMatchObject({ overlapsCaughtBefore: 1, conflictsFoundAfter: 1 });
  });

  it("approved without edits: Approve merges only the version whose checks passed", () => {
    expect(n.rows.map((r) => r.approvedWithoutEdits)).toEqual(["yes", "no", "no", ""]);
    expect(n.rows.map((r) => r.checksPassed)).toEqual(["yes", "yes", "", "no"]);
  });

  it("an empty log gives no numbers rather than zeros that look like results", () => {
    const empty = computeNumbers({ runs: [], events: [], briefings: [], actions: [], overlaps: [], conflicts: [], titles: new Map() });
    expect(empty.team).toMatchObject({ workOrders: 0, minutesToApprove: null, decisionsPerHandback: null });
  });
});

describe("CSV export", () => {
  const csv = numbersCsv(computeNumbers(input));
  const lines = csv.trimEnd().split("\r\n");

  it("has the measurement sheet's columns and one line per work order", () => {
    expect(lines[0]).toBe("Date,Handover,Owner,Work order,Task id,Check passed?,Outcome,Approved without edits?,Minutes to approve,Overlaps caught before,Conflicts found after");
    expect(lines).toHaveLength(5);
    expect(lines[1]).toBe("2026-10-24,2026-10-24,ana@example.com,Add greeting,a1,yes,accepted,yes,4,1,1");
  });

  it("quotes commas and never lets a spreadsheet run an agent-written formula", () => {
    expect(lines[3]).toContain('"Docs, part 2"');
    expect(lines[2]).toContain(`"'=HYPERLINK(""http://evil"")"`);
  });
});
