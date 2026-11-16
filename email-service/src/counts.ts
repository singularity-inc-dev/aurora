/**
 * Raw counts (milestone 6), as the plugin's `counts` route returns them, and the two
 * ways they are shown: the numbers page and `vt-numbers`. Counts only: nothing here
 * divides, averages or shows a percentage.
 */

export interface Counts {
  handedOver: number;
  ready: number;
  approved: number;
  rejected: number;
  failed: number;
  notTested: number;
  teammateOverlaps: number;
  wouldBeConflicts: number;
  toolErrors: number;
  checksFailed: number;
  timedOut: number;
  budgetStops: number;
}

export interface RawCounts {
  team: Counts;
  people: Array<{ owner: string; all: Counts; kinds: Array<{ kind: string; counts: Counts }> }>;
}

type Column = { key: keyof Counts; label: string };

/** The eight counts asked for, in order. */
export const MAIN_COLUMNS: readonly Column[] = [
  { key: "handedOver", label: "handed over" },
  { key: "ready", label: "ready" },
  { key: "approved", label: "approved" },
  { key: "rejected", label: "rejected" },
  { key: "failed", label: "failed" },
  { key: "notTested", label: "not tested" },
  { key: "teammateOverlaps", label: "teammate overlaps" },
  { key: "wouldBeConflicts", label: "would-be conflicts" },
];

/** How many tasks carry each run flag (rejected and not tested are in the main table). */
export const FLAG_COLUMNS: readonly Column[] = [
  { key: "toolErrors", label: "tool errors" },
  { key: "checksFailed", label: "checks failed" },
  { key: "timedOut", label: "timed out" },
  { key: "budgetStops", label: "budget stops" },
];

/** What each number means. Shown under every table so nobody has to guess. */
export const DEFINITIONS: readonly string[] = [
  "Handed over: tasks whose plan the owner approved, so the agent could start.",
  "Ready: tasks a handback email listed as Ready (each task once).",
  "Approved: tasks that are merged. A pull request still waiting for review is not counted yet.",
  "Rejected: tasks the owner rejected, tasks whose plan was rejected, and pull requests closed without a merge. This can be more than handed over, because a rejected plan never handed anything over.",
  "Failed: tasks that timed out after their retries.",
  "Not tested: tasks whose checks ran, but no test command was set up.",
  "Teammate overlaps: pairs of tasks owned by two different people that both changed at least one same file, whether or not git can merge them. A pair counts once in the team row and once for each of the two people.",
  "Would-be conflicts: of those pairs, the ones git could not merge. Nothing was merged.",
  "Run flags: how many tasks carry each flag. Tool errors are failed calls to Aurora's own tools; errors inside the agent's own commands are not seen.",
];

const NUMBER_KEYS: readonly (keyof Counts)[] = [...MAIN_COLUMNS, ...FLAG_COLUMNS].map((c) => c.key);

function isCounts(x: unknown): x is Counts {
  return typeof x === "object" && x !== null && NUMBER_KEYS.every((k) => Number.isInteger((x as Record<string, unknown>)[k]));
}

/** Check the plugin's answer before anything is shown (a wrong shape is an error, not a blank page). */
export function parseRawCounts(x: unknown): RawCounts {
  const bad = () => new Error("The plugin's counts answer was not in the expected shape.");
  const body = x as { team?: unknown; people?: unknown } | null;
  if (!body || !isCounts(body.team) || !Array.isArray(body.people)) throw bad();
  for (const p of body.people as Array<Record<string, unknown>>) {
    if (typeof p.owner !== "string" || !isCounts(p.all) || !Array.isArray(p.kinds)) throw bad();
    for (const k of p.kinds as Array<Record<string, unknown>>) if (typeof k.kind !== "string" || !isCounts(k.counts)) throw bad();
  }
  return body as RawCounts;
}

export interface CountRow {
  /** "Team", a person's email, or one task kind under a person. */
  label: string;
  level: "team" | "person" | "kind";
  counts: Counts;
}

/** Team first, then each person (all kinds) followed by that person's task kinds. */
export function countRows(n: RawCounts): CountRow[] {
  const rows: CountRow[] = [{ label: "Team (everyone)", level: "team", counts: n.team }];
  for (const p of n.people) {
    rows.push({ label: p.owner, level: "person", counts: p.all });
    for (const k of p.kinds) rows.push({ label: `task kind: ${k.kind}`, level: "kind", counts: k.counts });
  }
  return rows;
}

function table(rows: CountRow[], columns: readonly Column[]): string[] {
  const label = (r: CountRow) => (r.level === "kind" ? `  ${r.label}` : r.label);
  const width = Math.max("who".length, ...rows.map((r) => label(r).length));
  const widths = columns.map((c) => Math.max(c.label.length, ...rows.map((r) => String(r.counts[c.key]).length)));
  const line = (first: string, cells: string[]) => `${first.padEnd(width)}  ${cells.map((c, i) => c.padStart(widths[i]!)).join("  ")}`;
  return [line("who", columns.map((c) => c.label)), ...rows.map((r) => line(label(r), columns.map((c) => String(r.counts[c.key]))))];
}

/** The counts as plain text for the terminal. */
export function countsText(n: RawCounts): string {
  const rows = countRows(n);
  return [
    "Raw counts from the event log. Counts only: no percentages.",
    "",
    ...table(rows, MAIN_COLUMNS),
    "",
    "Run flags (tasks carrying each flag)",
    ...table(rows, FLAG_COLUMNS),
    "",
    "What the numbers mean",
    ...DEFINITIONS.map((d) => `- ${d}`),
    "",
  ].join("\n");
}
