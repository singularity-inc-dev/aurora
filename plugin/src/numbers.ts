/**
 * Numbers from the event log (thin version 1, piece F): the pilot's measures
 * (spec "Measures", playbook measurement sheet), computed from the plugin's own
 * tables only. Pure: the worker reads the rows and passes them in.
 */

type Row = Record<string, unknown>;

export interface NumbersInput {
  runs: Row[];
  events: Row[];
  briefings: Row[];
  actions: Row[];
  overlaps: Row[];
  conflicts: Row[];
  /** Ticket titles by task id (from the board). */
  titles: ReadonlyMap<string, string>;
}

/** One row per handed-over work order, in the playbook's measurement-sheet order. */
export interface SheetRow {
  date: string;
  handover: string;
  owner: string;
  taskId: string;
  workOrder: string;
  checksPassed: "yes" | "no" | "";
  outcome: string;
  approvedWithoutEdits: "yes" | "no" | "";
  minutesToApprove: number | null;
  overlapsCaughtBefore: number;
  conflictsFoundAfter: number;
}

export interface Measures {
  handovers: number;
  workOrders: number;
  accepted: number;
  rejected: number;
  blocked: number;
  failed: number;
  undecided: number;
  /** Accepted out of all handed-over work orders (null when there are none). */
  handoverYield: number | null;
  handbacks: number;
  /** Median, per handback, of minutes from the email being sent to its last decision. */
  minutesToApprove: number | null;
  /** Average number of items needing a decision per handback. */
  decisionsPerHandback: number | null;
  overlapsCaughtBefore: number;
  conflictsFoundAfter: number;
}

export interface Numbers {
  team: Measures;
  owners: Array<{ owner: string } & Measures>;
  rows: SheetRow[];
}

const json = <T>(v: unknown, fallback: T): T => {
  try {
    return JSON.parse(String(v)) as T;
  } catch {
    return fallback;
  }
};
const time = (v: unknown): number | null => (v ? new Date(String(v)).getTime() : null);
const median = (xs: number[]): number | null => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
};
const round = (x: number | null, digits = 1) => (x === null ? null : Math.round(x * 10 ** digits) / 10 ** digits);

export function computeNumbers(input: NumbersInput): Numbers {
  // Handed over = in a handover whose plan the owner approved.
  const handoverOf = new Map<string, Row>();
  for (const run of input.runs) for (const id of json<string[]>(run.task_ids, [])) handoverOf.set(id, run);
  const events = input.events.filter((e) => e.approved_at && handoverOf.has(String(e.task_id)));

  const sentAt = new Map(input.briefings.map((b) => [String(b.id), time(b.sent_at)]));
  const decidedIn = new Map<string, { briefing: string; at: number }>();
  for (const a of input.actions) {
    const at = time(a.used_at);
    if (a.state === "done" && at !== null) decidedIn.set(String(a.task_id), { briefing: String(a.briefing_id), at });
  }
  const minutesOf = (taskId: string): number | null => {
    const d = decidedIn.get(taskId);
    const sent = d ? sentAt.get(d.briefing) : null;
    return d && sent ? round(Math.max(0, (d.at - sent) / 60_000)) : null;
  };
  const conflictsOf = (taskId: string) => input.conflicts.filter((c) => c.task_a === taskId || c.task_b === taskId).length;

  const rows: SheetRow[] = events.map((e) => {
    const taskId = String(e.task_id);
    const run = handoverOf.get(taskId)!;
    const outcome = e.outcome ? String(e.outcome) : "undecided";
    return {
      date: String(e.proposed_at ?? run.created_at ?? "").slice(0, 10),
      handover: String(run.handover_key),
      owner: String(e.owner),
      taskId,
      workOrder: input.titles.get(taskId) ?? taskId,
      checksPassed: e.checks_result === "passed" ? "yes" : e.checks_result ? "no" : "",
      outcome,
      approvedWithoutEdits: outcome === "accepted" ? "yes" : outcome === "undecided" ? "" : "no",
      minutesToApprove: minutesOf(taskId),
      overlapsCaughtBefore: input.overlaps.filter((o) => o.owner === e.owner && o.handover_key === run.handover_key).length,
      conflictsFoundAfter: conflictsOf(taskId),
    };
  });

  const measure = (owner: string | null): Measures => {
    const mine = rows.filter((r) => owner === null || r.owner === owner);
    const count = (o: string) => mine.filter((r) => r.outcome === o).length;
    const briefings = input.briefings.filter((b) => b.sent_at && (owner === null || b.owner === owner));
    const minutes: number[] = [];
    const decisions: number[] = [];
    for (const b of briefings) {
      const items = json<Array<{ rejectActionId?: string | null }>>(b.items, []);
      decisions.push(items.filter((i) => i.rejectActionId).length);
      const last = Math.max(...input.actions.filter((a) => a.briefing_id === b.id && a.state === "done" && a.used_at).map((a) => time(a.used_at)!));
      const sent = time(b.sent_at)!;
      if (Number.isFinite(last)) minutes.push(Math.max(0, (last - sent) / 60_000));
    }
    const conflictKeys = new Set(
      input.conflicts.filter((c) => owner === null || c.owner_a === owner || c.owner_b === owner).map((c) => `${c.task_a}|${c.task_b}`),
    );
    return {
      handovers: new Set(mine.map((r) => `${r.owner}|${r.handover}`)).size,
      workOrders: mine.length,
      accepted: count("accepted"),
      rejected: count("rejected"),
      blocked: count("blocked"),
      failed: count("failed"),
      undecided: count("undecided"),
      handoverYield: mine.length ? round(count("accepted") / mine.length, 2) : null,
      handbacks: briefings.length,
      minutesToApprove: round(median(minutes)),
      decisionsPerHandback: decisions.length ? round(decisions.reduce((s, n) => s + n, 0) / decisions.length) : null,
      overlapsCaughtBefore: input.overlaps.filter((o) => owner === null || o.owner === owner).length,
      conflictsFoundAfter: conflictKeys.size,
    };
  };

  const ownerNames = [...new Set([...rows.map((r) => r.owner), ...input.overlaps.map((o) => String(o.owner))])].sort();
  return { team: measure(null), owners: ownerNames.map((owner) => ({ owner, ...measure(owner) })), rows };
}

const HEADER = [
  "Date",
  "Handover",
  "Owner",
  "Work order",
  "Task id",
  "Check passed?",
  "Outcome",
  "Approved without edits?",
  "Minutes to approve",
  "Overlaps caught before",
  "Conflicts found after",
];

/** One CSV cell. Cells that a spreadsheet would run as a formula get a leading apostrophe. */
function cell(v: unknown): string {
  let s = v === null || v === undefined ? "" : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** The measurement sheet as CSV (playbook columns that the event log can fill). */
export function numbersCsv(n: Numbers): string {
  const lines = [HEADER.map(cell).join(",")];
  for (const r of n.rows) {
    lines.push(
      [r.date, r.handover, r.owner, r.workOrder, r.taskId, r.checksPassed, r.outcome, r.approvedWithoutEdits, r.minutesToApprove, r.overlapsCaughtBefore, r.conflictsFoundAfter]
        .map(cell)
        .join(","),
    );
  }
  return `${lines.join("\r\n")}\r\n`;
}
