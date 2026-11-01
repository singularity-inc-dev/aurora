import { describe, expect, it } from "vitest";
import { DEFAULT_HANDOVER, type Person } from "../src/config.js";
import { decideHandover, type HandoverObservations, type HandoverRun } from "../src/handover.js";
import type { HandoverClock } from "../src/schedule.js";

const person: Person = {
  email: "ana@example.com",
  agentId: "agent-ana",
  agentEnvironmentId: null,
  agentUser: null,
  checksKey: null,
  modelAccess: null,
  timezone: "UTC",
  handoverStartHour: 22,
  maxTasksPerHandover: 3,
  handoverBudgetCapCents: 500,
  secrets: [],
};
const NOW = new Date("2026-10-21T23:00:00Z");
const clock = (phase: HandoverClock["phase"], handoverKey = "2026-10-21"): HandoverClock => ({
  phase,
  handoverKey,
  startsAt: new Date("2026-10-21T22:00:00Z"),
  endsAt: new Date("2026-10-22T06:00:00Z"),
});
const obs = (o: Partial<HandoverObservations> = {}): HandoverObservations => ({ approval: null, currentTaskStatus: null, spentCents: 0, ...o });
const run = (o: Partial<HandoverRun> = {}): HandoverRun => ({
  companyId: "co",
  owner: person.email,
  agentId: person.agentId,
  handoverKey: "2026-10-21",
  kind: "scheduled",
  startsAt: null,
  endsAt: null,
  status: "running",
  planIssueId: "plan",
  interactionId: "int",
  taskIds: ["t1", "t2", "t3"],
  currentIndex: 0,
  currentAttempt: 1,
  stepStartedAt: new Date("2026-10-21T22:30:00Z"),
  stopReason: null,
  ...o,
});
// The moment each test means: planning hours (21:00), the window (23:00), daytime (12:00).
const AT: Record<HandoverClock["phase"], Date> = { proposal: new Date("2026-10-21T21:00:00Z"), window: NOW, day: new Date("2026-10-21T12:00:00Z") };
const decide = (r: HandoverRun | null, c: HandoverClock, o: HandoverObservations, now?: Date) =>
  decideHandover(r, c, o, person, DEFAULT_HANDOVER, now ?? (c.handoverKey === "2026-10-21" ? AT[c.phase] : NOW));

describe("evening plan", () => {
  it("opens one plan per person in the proposal window only", () => {
    expect(decide(null, clock("proposal"), obs())).toEqual({ kind: "open-plan" });
    expect(decide(null, clock("day"), obs())).toEqual({ kind: "none" });
    expect(decide(null, clock("window"), obs())).toEqual({ kind: "none" });
  });

  it("waits for the agent to propose, and expires at night start if it never does", () => {
    expect(decide(run({ status: "proposing", taskIds: [] }), clock("proposal"), obs())).toEqual({ kind: "none" });
    expect(decide(run({ status: "proposing", taskIds: [] }), clock("window"), obs()).kind).toBe("expire");
  });

  it("approves on the owner's tap and records a rejection with its reason", () => {
    const waiting = run({ status: "awaiting_approval", currentIndex: -1 });
    expect(decide(waiting, clock("proposal"), obs({ approval: { status: "pending", outcome: null, reason: null } }))).toEqual({ kind: "none" });
    expect(decide(waiting, clock("proposal"), obs({ approval: { status: "accepted", outcome: "accepted", reason: null } }))).toEqual({ kind: "approve" });
    expect(decide(waiting, clock("window"), obs({ approval: { status: "rejected", outcome: "rejected", reason: "too risky" } }))).toEqual({
      kind: "reject",
      reason: "too risky",
    });
  });

  it("an unanswered plan expires once its night is over", () => {
    const waiting = run({ status: "awaiting_approval", currentIndex: -1 });
    expect(decide(waiting, clock("window"), obs()).kind).toBe("none");
    expect(decide(waiting, clock("day", "2026-10-22"), obs()).kind).toBe("expire");
  });
});

describe("night routine", () => {
  const approved = run({ status: "approved", currentIndex: -1, currentAttempt: 0, stepStartedAt: null });

  it("does not start approved work before the night starts", () => {
    expect(decide(approved, clock("proposal"), obs())).toEqual({ kind: "none" });
  });

  it("starts the first task at night start", () => {
    expect(decide(approved, clock("window"), obs())).toEqual({ kind: "advance", close: null, then: { start: 0 } });
  });

  it("moves to the next task when one is done", () => {
    expect(decide(run(), clock("window"), obs({ currentTaskStatus: "done" }))).toEqual({
      kind: "advance",
      close: { outcome: "finished", reason: null },
      then: { start: 1 },
    });
  });

  it("finishes after the last task", () => {
    expect(decide(run({ currentIndex: 2 }), clock("window"), obs({ currentTaskStatus: "in_review" }))).toMatchObject({
      then: { finish: "all tasks done" },
    });
  });

  it("closes a task the agent marked blocked and carries on", () => {
    expect(decide(run(), clock("window"), obs({ currentTaskStatus: "blocked" }))).toMatchObject({
      close: { outcome: "blocked" },
      then: { start: 1 },
    });
  });
});

describe("budget cap", () => {
  it("never starts work once the cap is reached", () => {
    const approved = run({ status: "approved", currentIndex: -1 });
    expect(decide(approved, clock("window"), obs({ spentCents: 500 }))).toEqual({ kind: "advance", close: null, then: { budgetStop: true } });
  });

  it("stops a running night when spend reaches the cap", () => {
    expect(decide(run(), clock("window"), obs({ spentCents: 501, currentTaskStatus: "in_progress" }))).toEqual({
      kind: "advance",
      close: { outcome: "blocked", reason: "handover budget cap reached" },
      then: { budgetStop: true },
    });
  });

  it("a finished task still counts as finished, but nothing new starts", () => {
    expect(decide(run(), clock("window"), obs({ spentCents: 900, currentTaskStatus: "done" }))).toMatchObject({
      close: { outcome: "finished" },
      then: { budgetStop: true },
    });
  });

  it("a cap of 0 means no work at all", () => {
    const zero = { ...person, handoverBudgetCapCents: 0 };
    const approved = run({ status: "approved", currentIndex: -1 });
    expect(decideHandover(approved, clock("window"), obs(), zero, DEFAULT_HANDOVER, NOW)).toMatchObject({ then: { budgetStop: true } });
  });
});

describe("time-outs and retries", () => {
  const late = new Date("2026-10-21T23:31:00Z"); // 61 minutes after the step started

  it("retries a step that ran past its time limit", () => {
    expect(decide(run(), clock("window"), obs({ currentTaskStatus: "in_progress" }), late)).toEqual({ kind: "retry-step", attempt: 2 });
  });

  it("fails the step once retries are used up, then moves on", () => {
    expect(decide(run({ currentAttempt: 2 }), clock("window"), obs({ currentTaskStatus: "in_progress" }), late)).toMatchObject({
      close: { outcome: "failed" },
      then: { start: 1 },
    });
  });

  it("does nothing while a step is within its time limit", () => {
    expect(decide(run(), clock("window"), obs({ currentTaskStatus: "in_progress" }))).toEqual({ kind: "none" });
  });

  it("blocks the current task when the night ends", () => {
    expect(decide(run(), clock("day", "2026-10-22"), obs({ currentTaskStatus: "in_progress" }))).toEqual({
      kind: "advance",
      close: { outcome: "blocked", reason: "the handover ended" },
      then: { finish: "the handover ended" },
    });
  });
});

describe("Hand over now (a handover with its own window)", () => {
  const start = new Date("2026-10-24T14:05:00Z");
  const end = new Date("2026-10-24T22:05:00Z");
  const now = (o: Partial<HandoverRun> = {}) =>
    run({ kind: "now", handoverKey: "2026-10-24T14:05:00", startsAt: start, endsAt: end, status: "proposing", planIssueId: null, taskIds: [], currentIndex: -1, ...o });
  const daytime = clock("day", "2026-10-24");
  const at = (iso: string) => new Date(iso);

  it("opens its plan right away, whatever the schedule says", () => {
    expect(decide(now(), daytime, obs(), at("2026-10-24T14:05:00Z"))).toEqual({ kind: "open-plan" });
  });

  it("starts work as soon as the plan is approved", () => {
    const approved = now({ status: "approved", planIssueId: "p", taskIds: ["t1"] });
    expect(decide(approved, daytime, obs(), at("2026-10-24T14:20:00Z"))).toEqual({ kind: "advance", close: null, then: { start: 0 } });
  });

  it("expires when nothing is proposed or approved within its window", () => {
    expect(decide(now({ planIssueId: "p" }), daytime, obs(), at("2026-10-24T22:06:00Z")).kind).toBe("expire");
    expect(decide(now({ status: "awaiting_approval", planIssueId: "p" }), daytime, obs(), at("2026-10-24T22:06:00Z")).kind).toBe("expire");
  });

  it("stops its running task when its window ends", () => {
    const running = now({ status: "running", planIssueId: "p", taskIds: ["t1"], currentIndex: 0, stepStartedAt: at("2026-10-24T21:30:00Z") });
    expect(decide(running, daytime, obs(), at("2026-10-24T22:06:00Z"))).toEqual({
      kind: "advance",
      close: { outcome: "blocked", reason: "the handover ended" },
      then: { finish: "the handover ended" },
    });
  });

  it("a scheduled handover with a stored window follows that window", () => {
    const sched = run({ status: "approved", startsAt: at("2026-10-21T22:00:00Z"), endsAt: at("2026-10-22T06:00:00Z") });
    expect(decide(sched, clock("proposal"), obs(), at("2026-10-21T21:59:00Z"))).toEqual({ kind: "none" });
    expect(decide(sched, clock("window"), obs(), at("2026-10-21T22:01:00Z")).kind).toBe("advance");
  });

  it("a scheduled handover follows the owner's new hour if it is moved after the plan opened", () => {
    // Stored 22:00-06:00; the owner moved the hour to 20:00 the same day.
    const sched = run({ status: "approved", startsAt: at("2026-10-21T22:00:00Z"), endsAt: at("2026-10-22T06:00:00Z") });
    const moved: HandoverClock = { phase: "window", handoverKey: "2026-10-21", startsAt: at("2026-10-21T20:00:00Z"), endsAt: at("2026-10-22T04:00:00Z") };
    expect(decide(sched, moved, obs(), at("2026-10-21T20:30:00Z")).kind).toBe("advance");
    // Next day's clock: the stored window applies, and it is over by then.
    expect(decide(sched, clock("day", "2026-10-22"), obs(), at("2026-10-22T12:00:00Z")).kind).toBe("expire");
  });
});
