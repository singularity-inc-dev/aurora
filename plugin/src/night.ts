import type { NightSettings, Person } from "./config.js";
import type { NightClock } from "./nightclock.js";

export type NightStatus =
  | "proposing"
  | "awaiting_approval"
  | "approved"
  | "running"
  | "rejected"
  | "finished"
  | "budget_stopped"
  | "expired";

export const OPEN_STATUSES: readonly NightStatus[] = ["proposing", "awaiting_approval", "approved", "running"];

/** One person's night (the "night routine"); at most one per person per night. */
export interface NightRun {
  companyId: string;
  owner: string;
  agentId: string;
  nightDate: string;
  status: NightStatus;
  planIssueId: string | null;
  interactionId: string | null;
  taskIds: string[];
  /** Index into taskIds of the task being worked on, -1 before the first. */
  currentIndex: number;
  currentAttempt: number;
  stepStartedAt: Date | null;
  stopReason: string | null;
}

export interface NightObservations {
  /** Owner's answer on the plan ticket, once there is one. */
  approval: { status: string; outcome: string | null; reason: string | null } | null;
  /** Board status of the task currently being worked on. */
  currentTaskStatus: string | null;
  /** Cost recorded for this agent since the night started, in cents. */
  spentCents: number;
}

export type StepClose = { outcome: "finished" | "blocked" | "failed"; reason: string | null };
export type NextStep = { start: number } | { finish: string } | { budgetStop: true };

export type NightDecision =
  | { kind: "none" }
  | { kind: "open-plan" }
  | { kind: "approve" }
  | { kind: "reject"; reason: string | null }
  | { kind: "expire"; reason: string }
  | { kind: "retry-step"; attempt: number }
  | { kind: "advance"; close: StepClose | null; then: NextStep };

const DONE_STATUSES = new Set(["done", "in_review"]);
const STOPPED_STATUSES = new Set(["blocked", "cancelled"]);

function nextStep(run: NightRun, index: number, overBudget: boolean): NextStep {
  if (index >= run.taskIds.length) return { finish: "all tasks done" };
  if (overBudget) return { budgetStop: true };
  return { start: index };
}

/**
 * Decide the one next thing to do for a person's night. Pure: the worker
 * observes Paperclip, calls this, then carries out the decision.
 */
export function decideNight(
  run: NightRun | null,
  clock: NightClock,
  obs: NightObservations,
  person: Person,
  night: NightSettings,
  now: Date,
): NightDecision {
  if (!run) return clock.phase === "proposal" ? { kind: "open-plan" } : { kind: "none" };

  const inItsNight = clock.phase === "night" && clock.nightDate === run.nightDate;
  const nightOver = !inItsNight && (clock.phase === "night" || clock.nightDate !== run.nightDate);
  const overBudget = obs.spentCents >= person.nightBudgetCapCents;

  switch (run.status) {
    case "proposing":
      if (!run.planIssueId) return clock.phase === "proposal" ? { kind: "open-plan" } : { kind: "expire", reason: "plan could not be opened" };
      if (inItsNight || nightOver) return { kind: "expire", reason: "no tasks were proposed before the night started" };
      return { kind: "none" };

    case "awaiting_approval": {
      const a = obs.approval;
      if (a && a.status !== "pending") {
        if (a.status === "accepted" || a.outcome === "accepted") return { kind: "approve" };
        return { kind: "reject", reason: a.reason ?? a.outcome ?? a.status };
      }
      if (nightOver) return { kind: "expire", reason: "plan was not approved before the night ended" };
      return { kind: "none" };
    }

    case "approved":
      if (nightOver) return { kind: "expire", reason: "night ended before work started" };
      if (!inItsNight) return { kind: "none" };
      return { kind: "advance", close: null, then: nextStep(run, 0, overBudget) };

    case "running": {
      const status = obs.currentTaskStatus;
      const next = (close: StepClose): NightDecision => ({ kind: "advance", close, then: nextStep(run, run.currentIndex + 1, overBudget) });
      if (status && DONE_STATUSES.has(status)) {
        return nightOver
          ? { kind: "advance", close: { outcome: "finished", reason: null }, then: { finish: "night ended" } }
          : next({ outcome: "finished", reason: null });
      }
      if (nightOver) return { kind: "advance", close: { outcome: "blocked", reason: "night ended" }, then: { finish: "night ended" } };
      if (overBudget) {
        return { kind: "advance", close: { outcome: "blocked", reason: "night budget cap reached" }, then: { budgetStop: true } };
      }
      if (status && STOPPED_STATUSES.has(status)) return next({ outcome: "blocked", reason: `agent marked the task ${status}` });
      const started = run.stepStartedAt?.getTime() ?? now.getTime();
      if (now.getTime() - started > night.stepTimeoutMinutes * 60_000) {
        if (run.currentAttempt <= night.maxRetries) return { kind: "retry-step", attempt: run.currentAttempt + 1 };
        return next({ outcome: "failed", reason: `timed out ${run.currentAttempt} time(s) after ${night.stepTimeoutMinutes} minutes` });
      }
      return { kind: "none" };
    }

    default:
      return { kind: "none" };
  }
}
