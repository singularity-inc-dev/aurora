/**
 * The event log as CSV: one row per task, the columns CLAUDE.md lists, plus the
 * task's run flags. Raw values only; nothing is computed here.
 */
import { csvText } from "./csv.js";
import { flagsOf, type RunFlag } from "./flags.js";

type Row = Record<string, unknown>;

export const EVENT_LOG_HEADER = [
  "task id",
  "owner",
  "agent",
  "task kind",
  "proposed at",
  "approved at",
  "started at",
  "finished at",
  "checks result",
  "outcome",
  "reject reason",
  "handed off to",
  "run flags",
  "flag details",
] as const;

/** A time as ISO text, whether the database gave a Date or text. */
export function iso(v: unknown): string {
  if (v instanceof Date) return v.toISOString();
  return v === null || v === undefined ? "" : String(v);
}

export function eventLogCsv(events: Row[], storedFlags: ReadonlyMap<string, readonly RunFlag[]>): string {
  const sorted = [...events].sort((a, b) => (iso(a.proposed_at) || "~").localeCompare(iso(b.proposed_at) || "~") || String(a.task_id).localeCompare(String(b.task_id)));
  return csvText(
    EVENT_LOG_HEADER,
    sorted.map((e) => {
      const flags = flagsOf(e, storedFlags.get(String(e.task_id)) ?? []);
      return [
        e.task_id,
        e.owner,
        e.agent,
        e.task_kind,
        iso(e.proposed_at),
        iso(e.approved_at),
        iso(e.started_at),
        iso(e.finished_at),
        e.checks_result,
        e.outcome,
        e.reject_reason,
        e.handed_off_to,
        flags.map((f) => f.kind).join(";"),
        flags.filter((f) => f.detail).map((f) => `${f.kind}: ${f.detail}`).join(" | "),
      ];
    }),
  );
}
