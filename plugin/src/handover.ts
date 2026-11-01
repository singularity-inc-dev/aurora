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

export interface HandoverObservations {
  /** Owner's answer on the plan ticket, once there is one. */
  approval: { status: string; outcome: string | null; reason: string | null } | null;
  /** Board status of the task currently being worked on. */
  currentTaskStatus: string | null;
  /** Cost recorded for this agent since the handover's window started, in cents. */
  spentCents: number;
}

/**
 * How a step ended. `cutOff`: the window ended while the agent was still on it.
 * The plugin cannot stop that run, and its work may still land and be approved (B4).
 */
export type StepClose = { outcome: "finished" | "blocked" | "failed"; reason: string | null; cutOff?: boolean };

/** Why a handover finished when its window ended. */
export const WINDOW_ENDED = "the handover ended";
export type NextStep = { start: number } | { finish: string } | { budgetStop: true };

export type HandoverDecision =
  | { kind: "none" }
  | { kind: "open-plan" }
  | { kind: "approve" }
  | { kind: "reject"; reason: string | null }
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
  if (!run) return clock.phase === "proposal" ? { kind: "open-plan" } : { kind: "none" };

  const w = windowOf(run, clock);
  const inItsWindow = now >= w.start && now < w.end;
  const windowOver = now >= w.end;
  const overBudget = obs.spentCents >= person.handoverBudgetCapCents;

  switch (run.status) {
    case "proposing":
      if (!run.planIssueId) {
        // A "now" handover plans right away; a scheduled one only in its planning hours.
        const canOpen = run.kind === "now" ? !windowOver : clock.phase === "proposal" && clock.handoverKey === run.handoverKey;
        return canOpen ? { kind: "open-plan" } : { kind: "expire", reason: "plan could not be opened" };
      }
      if (run.kind === "now" ? windowOver : inItsWindow || windowOver) {
        return { kind: "expire", reason: run.kind === "now" ? "no tasks were proposed in time" : "no tasks were proposed before the handover started" };
      }
      // Planning is an agent step too: past its time limit the agent is woken again on the plan ticket.
      if (run.stepStartedAt && now.getTime() - run.stepStartedAt.getTime() > handover.stepTimeoutMinutes * 60_000 && run.currentAttempt <= handover.maxRetries) {
        return { kind: "retry-step", attempt: run.currentAttempt + 1 };
      }
      return { kind: "none" };

    case "awaiting_approval": {
      const a = obs.approval;
      if (a && a.status !== "pending") {
        if (a.status === "accepted" || a.outcome === "accepted") return { kind: "approve" };
        return { kind: "reject", reason: a.reason ?? a.outcome ?? a.status };
      }
      if (windowOver) return { kind: "expire", reason: "plan was not approved before the handover ended" };
      return { kind: "none" };
    }

    case "approved":
      if (windowOver) return { kind: "expire", reason: "the handover ended before work started" };
      if (!inItsWindow) return { kind: "none" };
      return { kind: "advance", close: null, then: nextStep(run, 0, overBudget) };

    case "running": {
      const status = obs.currentTaskStatus;
      const next = (close: StepClose): HandoverDecision => ({ kind: "advance", close, then: nextStep(run, run.currentIndex + 1, overBudget) });
      if (status && DONE_STATUSES.has(status)) {
        return windowOver
          ? { kind: "advance", close: { outcome: "finished", reason: null }, then: { finish: WINDOW_ENDED } }
          : next({ outcome: "finished", reason: null });
      }
      if (windowOver) return { kind: "advance", close: { outcome: "blocked", reason: WINDOW_ENDED, cutOff: true }, then: { finish: WINDOW_ENDED } };
      if (overBudget) {
        return { kind: "advance", close: { outcome: "blocked", reason: "handover budget cap reached" }, then: { budgetStop: true } };
      }
      if (status && STOPPED_STATUSES.has(status)) return next({ outcome: "blocked", reason: `agent marked the task ${status}` });
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
