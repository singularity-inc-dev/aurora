/**
 * Run flags (milestone 6): what went wrong, or needs a second look, on one task.
 *
 * Six kinds. Three are stored when they happen, because nothing else keeps them
 * (a tool error, a timeout, a budget stop). Three are read from the event log, so
 * they can never disagree with it (failed checks, not tested, rejected).
 *
 * Pure: no database, no clock.
 */

export type FlagKind = "tool-error" | "checks-failed" | "not-tested" | "timeout" | "budget-stop" | "rejected";

/** Flags written by `flagstore.ts` when the event happens. */
export const STORED_FLAGS = ["tool-error", "timeout", "budget-stop"] as const satisfies readonly FlagKind[];
export type StoredFlagKind = (typeof STORED_FLAGS)[number];

/** The order flags are shown in: the ones that stop work first. */
export const FLAG_ORDER: readonly FlagKind[] = ["tool-error", "checks-failed", "not-tested", "timeout", "budget-stop", "rejected"];

export const FLAG_LABEL: Record<FlagKind, string> = {
  "tool-error": "tool error",
  "checks-failed": "checks failed",
  "not-tested": "not tested",
  timeout: "timed out",
  "budget-stop": "budget stop",
  rejected: "rejected",
};

export interface RunFlag {
  kind: FlagKind;
  /** One short line (never a secret, never a file's content). */
  detail: string | null;
}

/** The parts of an event-log row that the derived flags read. */
export interface FlagEventRow {
  checks_result?: unknown;
  outcome?: unknown;
  reject_reason?: unknown;
}

const MAX_DETAIL = 200;

/** Keep a detail to one short line. */
export function cleanDetail(text: string | null | undefined): string | null {
  const one = (text ?? "").replace(/\s+/g, " ").trim();
  if (!one) return null;
  return one.length > MAX_DETAIL ? `${one.slice(0, MAX_DETAIL - 1)}…` : one;
}

/** All flags on a task: the stored ones plus the ones the event log implies. */
export function flagsOf(event: FlagEventRow | null | undefined, stored: readonly RunFlag[]): RunFlag[] {
  const found = new Map<FlagKind, RunFlag>();
  for (const s of stored) found.set(s.kind, s);
  const checks = event?.checks_result;
  if (checks === "failed") found.set("checks-failed", { kind: "checks-failed", detail: null });
  if (checks === "not-tested") found.set("not-tested", { kind: "not-tested", detail: "no test command ran" });
  if (event?.outcome === "rejected") {
    found.set("rejected", { kind: "rejected", detail: cleanDetail(typeof event.reject_reason === "string" ? event.reject_reason : null) ?? "no reason given" });
  }
  return FLAG_ORDER.filter((k) => found.has(k)).map((k) => found.get(k)!);
}

/** "checks failed, timed out (after 2 tries)" for one line of an email or a CSV cell. */
export function describeFlags(flags: readonly RunFlag[]): string {
  return flags.map((f) => (f.detail ? `${FLAG_LABEL[f.kind]} (${f.detail})` : FLAG_LABEL[f.kind])).join(", ");
}
