import { describe, expect, it } from "vitest";
import { DEFAULT_NIGHT, type Person } from "../src/config.js";
import { decideNight, type NightObservations, type NightRun } from "../src/night.js";
import type { NightClock } from "../src/nightclock.js";

const person: Person = {
  email: "ana@example.com",
  agentId: "agent-ana",
  timezone: "UTC",
  nightStartHour: 22,
  maxTasksPerNight: 3,
  nightBudgetCapCents: 500,
  secrets: [],
};
const NOW = new Date("2026-10-21T23:00:00Z");
const clock = (phase: NightClock["phase"], nightDate = "2026-10-21"): NightClock => ({
  phase,
  nightDate,
  startsAt: new Date("2026-10-21T22:00:00Z"),
  endsAt: new Date("2026-10-22T06:00:00Z"),
});
const obs = (o: Partial<NightObservations> = {}): NightObservations => ({ approval: null, currentTaskStatus: null, spentCents: 0, ...o });
const run = (o: Partial<NightRun> = {}): NightRun => ({
  companyId: "co",
  owner: person.email,
  agentId: person.agentId,
  nightDate: "2026-10-21",
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
const decide = (r: NightRun | null, c: NightClock, o: NightObservations, now = NOW) => decideNight(r, c, o, person, DEFAULT_NIGHT, now);

describe("evening plan", () => {
  it("opens one plan per person in the proposal window only", () => {
    expect(decide(null, clock("proposal"), obs())).toEqual({ kind: "open-plan" });
    expect(decide(null, clock("day"), obs())).toEqual({ kind: "none" });
    expect(decide(null, clock("night"), obs())).toEqual({ kind: "none" });
  });

  it("waits for the agent to propose, and expires at night start if it never does", () => {
    expect(decide(run({ status: "proposing", taskIds: [] }), clock("proposal"), obs())).toEqual({ kind: "none" });
    expect(decide(run({ status: "proposing", taskIds: [] }), clock("night"), obs()).kind).toBe("expire");
  });

  it("approves on the owner's tap and records a rejection with its reason", () => {
    const waiting = run({ status: "awaiting_approval", currentIndex: -1 });
    expect(decide(waiting, clock("proposal"), obs({ approval: { status: "pending", outcome: null, reason: null } }))).toEqual({ kind: "none" });
    expect(decide(waiting, clock("proposal"), obs({ approval: { status: "accepted", outcome: "accepted", reason: null } }))).toEqual({ kind: "approve" });
    expect(decide(waiting, clock("night"), obs({ approval: { status: "rejected", outcome: "rejected", reason: "too risky" } }))).toEqual({
      kind: "reject",
      reason: "too risky",
    });
  });

  it("an unanswered plan expires once its night is over", () => {
    const waiting = run({ status: "awaiting_approval", currentIndex: -1 });
    expect(decide(waiting, clock("night"), obs()).kind).toBe("none");
    expect(decide(waiting, clock("day", "2026-10-22"), obs()).kind).toBe("expire");
  });
});

describe("night routine", () => {
  const approved = run({ status: "approved", currentIndex: -1, currentAttempt: 0, stepStartedAt: null });

  it("does not start approved work before the night starts", () => {
    expect(decide(approved, clock("proposal"), obs())).toEqual({ kind: "none" });
  });

  it("starts the first task at night start", () => {
    expect(decide(approved, clock("night"), obs())).toEqual({ kind: "advance", close: null, then: { start: 0 } });
  });

  it("moves to the next task when one is done", () => {
    expect(decide(run(), clock("night"), obs({ currentTaskStatus: "done" }))).toEqual({
      kind: "advance",
      close: { outcome: "finished", reason: null },
      then: { start: 1 },
    });
  });

  it("finishes after the last task", () => {
    expect(decide(run({ currentIndex: 2 }), clock("night"), obs({ currentTaskStatus: "in_review" }))).toMatchObject({
      then: { finish: "all tasks done" },
    });
  });

  it("closes a task the agent marked blocked and carries on", () => {
    expect(decide(run(), clock("night"), obs({ currentTaskStatus: "blocked" }))).toMatchObject({
      close: { outcome: "blocked" },
      then: { start: 1 },
    });
  });
});

describe("budget cap", () => {
  it("never starts work once the cap is reached", () => {
    const approved = run({ status: "approved", currentIndex: -1 });
    expect(decide(approved, clock("night"), obs({ spentCents: 500 }))).toEqual({ kind: "advance", close: null, then: { budgetStop: true } });
  });

  it("stops a running night when spend reaches the cap", () => {
    expect(decide(run(), clock("night"), obs({ spentCents: 501, currentTaskStatus: "in_progress" }))).toEqual({
      kind: "advance",
      close: { outcome: "blocked", reason: "night budget cap reached" },
      then: { budgetStop: true },
    });
  });

  it("a finished task still counts as finished, but nothing new starts", () => {
    expect(decide(run(), clock("night"), obs({ spentCents: 900, currentTaskStatus: "done" }))).toMatchObject({
      close: { outcome: "finished" },
      then: { budgetStop: true },
    });
  });

  it("a cap of 0 means no work at all", () => {
    const zero = { ...person, nightBudgetCapCents: 0 };
    const approved = run({ status: "approved", currentIndex: -1 });
    expect(decideNight(approved, clock("night"), obs(), zero, DEFAULT_NIGHT, NOW)).toMatchObject({ then: { budgetStop: true } });
  });
});

describe("time-outs and retries", () => {
  const late = new Date("2026-10-21T23:31:00Z"); // 61 minutes after the step started

  it("retries a step that ran past its time limit", () => {
    expect(decide(run(), clock("night"), obs({ currentTaskStatus: "in_progress" }), late)).toEqual({ kind: "retry-step", attempt: 2 });
  });

  it("fails the step once retries are used up, then moves on", () => {
    expect(decide(run({ currentAttempt: 2 }), clock("night"), obs({ currentTaskStatus: "in_progress" }), late)).toMatchObject({
      close: { outcome: "failed" },
      then: { start: 1 },
    });
  });

  it("does nothing while a step is within its time limit", () => {
    expect(decide(run(), clock("night"), obs({ currentTaskStatus: "in_progress" }))).toEqual({ kind: "none" });
  });

  it("blocks the current task when the night ends", () => {
    expect(decide(run(), clock("day", "2026-10-22"), obs({ currentTaskStatus: "in_progress" }))).toEqual({
      kind: "advance",
      close: { outcome: "blocked", reason: "night ended" },
      then: { finish: "night ended" },
    });
  });
});
