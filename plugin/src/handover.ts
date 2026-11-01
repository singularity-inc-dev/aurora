import type { HandoverSettings, Person } from "./config.js";
import type { HandoverClock } from "./schedule.js";

export type HandoverStatus =
  | "proposing"
  | "awaiting_approval"
  | "approved"
  | "running"
  | "rejected"
  | "finished"
  | "budget_stopped"
  | "expired";

export const OPEN_STATUSES: readonly HandoverStatus[] = ["proposing", "awaiting_approval", "approved", "running"];

/** "scheduled": the person's daily handover time. "now": the owner tapped Hand over now. */
export type HandoverKind = "scheduled" | "now";

/** One handover of one person: plan, approval, then work in its window. At most one is open per person. */
export interface HandoverRun {
  companyId: string;
  owner: string;
  agentId: string;
  /** The scheduled day (YYYY-MM-DD), or the start of a "now" handover (YYYY-MM-DDTHH:MM:SS, UTC). */
  handoverKey: string;
  kind: HandoverKind;
  /** When agents may work. Null only for handovers recorded before windows were stored. */
  startsAt: Date | null;
  endsAt: Date | null;
  status: HandoverStatus;
  planIssueId: string | null;
  interactionId: string | null;
  taskIds: string[];
  /** Index into taskIds of the task being worked on, -1 before the first. */
  currentIndex: number;
  currentAttempt: number;
  stepStartedAt: Date | null;
  stopReason: string | null;
}

/** What the current task's handover note allows, and what it has used so far. */
export interface TaskLimitsSeen {
  maxMinutes: number;
  budgetCents: number;
  /** When the task first started (its first attempt). */
  startedAt: Date | null;
  /** Cost recorded for the agent since the task started, in cents. */
  spentCents: number;
}

export interface HandoverObservations {
  /** Board status of the task currently being worked on. */
  currentTaskStatus: string | null;
  /** Cost recorded for this agent since the handover's window started, in cents. */
  spentCents: number;
  /** The current task's note limits (null: a task without a note, e.g. from before notes existed). */
  currentTask?: TaskLimitsSeen | null;
  /** Notes the owner handed over for their next scheduled window that have not started yet. */
  queuedNotes?: number;
}

export type StepClose = { outcome: "finished" | "blocked" | "failed"; reason: string | null };
export type NextStep = { start: number } | { finish: string } | { budgetStop: true };

export type HandoverDecision =
  | { kind: "none" }
  /** Start the scheduled handover with exactly the notes the owner queued for it. */
  | { kind: "start-queued" }
  | { kind: "expire"; reason: string }
  | { kind: "retry-step"; attempt: number }
  | { kind: "advance"; close: StepClose | null; then: NextStep };

const DONE_STATUSES = new Set(["done", "in_review"]);
const STOPPED_STATUSES = new Set(["blocked", "cancelled"]);

/**
 * The window in which a handover's agents may work. A "now" handover keeps the
 * window it was given. A scheduled one follows the live schedule while it is
 * still that day's (the owner may move the hour after the plan opened), then
 * the window stored when it was claimed; with none stored, one that is over.
 */
export function windowOf(run: HandoverRun, clock: HandoverClock): { start: Date; end: Date } {
  if (run.kind === "now" && run.startsAt && run.endsAt) return { start: run.startsAt, end: run.endsAt };
  if (run.kind === "scheduled" && clock.handoverKey === run.handoverKey) return { start: clock.startsAt, end: clock.endsAt };
  if (run.startsAt && run.endsAt) return { start: run.startsAt, end: run.endsAt };
  return { start: new Date(0), end: new Date(0) };
}

function nextStep(run: HandoverRun, index: number, overBudget: boolean): NextStep {
  if (index >= run.taskIds.length) return { finish: "all tasks done" };
  if (overBudget) return { budgetStop: true };
  return { start: index };
}

/**
 * Decide the one next thing to do for a person's handover. Pure: the worker
 * observes Paperclip, calls this, then carries out the decision.
 */
export function decideHandover(
  run: HandoverRun | null,
  clock: HandoverClock,
  obs: HandoverObservations,
  person: Person,
  handover: HandoverSettings,
  now: Date,
): HandoverDecision {
  // The owner's tap is the approval: a scheduled handover only ever starts from notes the owner queued.
  if (!run) return (obs.queuedNotes ?? 0) > 0 ? { kind: "start-queued" } : { kind: "none" };

  const w = windowOf(run, clock);
  const inItsWindow = now >= w.start && now < w.end;
  const windowOver = now >= w.end;
  const overBudget = obs.spentCents >= person.handoverBudgetCapCents;

  switch (run.status) {
    // Handovers from before the owner's note: the agent proposed and someone approved a plan.
    // That step no longer exists, so such a handover ends without work.
    case "proposing":
    case "awaiting_approval":
      return { kind: "expire", reason: "plans are no longer approved in Paperclip; hand the tasks over on your Hand over page" };

    case "approved":
      if (windowOver) return { kind: "expire", reason: "the handover ended before work started" };
      if (!inItsWindow) return { kind: "none" };
      return { kind: "advance", close: null, then: nextStep(run, 0, overBudget) };

    case "running": {
      const status = obs.currentTaskStatus;
      const next = (close: StepClose): HandoverDecision => ({ kind: "advance", close, then: nextStep(run, run.currentIndex + 1, overBudget) });
      if (status && DONE_STATUSES.has(status)) {
        return windowOver
          ? { kind: "advance", close: { outcome: "finished", reason: null }, then: { finish: "the handover ended" } }
          : next({ outcome: "finished", reason: null });
      }
      if (windowOver) return { kind: "advance", close: { outcome: "blocked", reason: "the handover ended" }, then: { finish: "the handover ended" } };
      if (overBudget) {
        return { kind: "advance", close: { outcome: "blocked", reason: "handover budget cap reached" }, then: { budgetStop: true } };
      }
      const task = obs.currentTask ?? null;
      if (task && task.spentCents >= task.budgetCents) return next({ outcome: "blocked", reason: `its budget of ${task.budgetCents} cents was reached` });
      if (status && STOPPED_STATUSES.has(status)) return next({ outcome: "blocked", reason: `agent marked the task ${status}` });
      if (task?.startedAt && now.getTime() - task.startedAt.getTime() > task.maxMinutes * 60_000) {
        return next({ outcome: "failed", reason: `its time limit of ${task.maxMinutes} minutes was reached` });
      }
      const started = run.stepStartedAt?.getTime() ?? now.getTime();
      if (now.getTime() - started > handover.stepTimeoutMinutes * 60_000) {
        if (run.currentAttempt <= handover.maxRetries) return { kind: "retry-step", attempt: run.currentAttempt + 1 };
        return next({ outcome: "failed", reason: `timed out ${run.currentAttempt} time(s) after ${handover.stepTimeoutMinutes} minutes` });
      }
      return { kind: "none" };
    }

    default:
      return { kind: "none" };
  }
}
