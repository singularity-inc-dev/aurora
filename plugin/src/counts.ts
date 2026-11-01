/**
 * Raw counts (milestone 6): how many tasks fall in each bucket, per person and per
 * task kind, from the plugin's own tables. Counts only: no percentages, no rates,
 * no averages. Pure: the worker reads the rows and passes them in.
 *
 * What each number means (the numbers page and `vt-numbers` print the same words):
 *   handedOver        tasks whose plan the owner approved (the agent was allowed to start)
 *   ready             tasks that a handback email listed as Ready (once per task, however many emails)
 *   approved          tasks that are merged (outcome "accepted"); a pull request still waiting for review is not counted yet
 *   rejected          tasks with outcome "rejected": the owner's Reject, a rejected plan, or a pull request closed unmerged
 *   failed            tasks with outcome "failed" (timed out after the retries)
 *   notTested         tasks whose checks ran but no test command was set up (checks result "not-tested")
 *   teammateOverlaps  pairs of tasks, owned by two different people, that both changed at least one same file
 *                     (merged cleanly by git, or not). Each pair counts once in the team total and once for each
 *                     of the two people, so the people's rows add up to twice the team's.
 *   wouldBeConflicts  of those pairs, the ones git could not merge
 * Run-flag columns: how many tasks carry that flag (see flags.ts).
 */
import { flagsOf, type FlagKind, type RunFlag } from "./flags.js";

type Row = Record<string, unknown>;

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

export const COUNT_KEYS = [
  "handedOver",
  "ready",
  "approved",
  "rejected",
  "failed",
  "notTested",
  "teammateOverlaps",
  "wouldBeConflicts",
  "toolErrors",
  "checksFailed",
  "timedOut",
  "budgetStops",
] as const satisfies ReadonlyArray<keyof Counts>;

export interface RawCounts {
  team: Counts;
  people: Array<{ owner: string; all: Counts; kinds: Array<{ kind: string; counts: Counts }> }>;
}

export interface CountsInput {
  /** `task_events` rows. */
  events: Row[];
  /** Stored run flags by task id. */
  flags: ReadonlyMap<string, readonly RunFlag[]>;
  /** `briefings` rows (their items say what was Ready; their shared files say what overlapped cleanly). */
  briefings: Row[];
  /** `conflicts` rows. */
  conflicts: Row[];
}

const zero = (): Counts => Object.fromEntries(COUNT_KEYS.map((k) => [k, 0])) as unknown as Counts;
const add = (into: Counts, from: Counts) => {
  for (const k of COUNT_KEYS) into[k] += from[k];
};
const json = <T>(v: unknown, fallback: T): T => {
  try {
    return typeof v === "string" ? (JSON.parse(v) as T) : fallback;
  } catch {
    return fallback;
  }
};

const FLAG_COLUMN: Partial<Record<FlagKind, keyof Counts>> = {
  "tool-error": "toolErrors",
  "checks-failed": "checksFailed",
  timeout: "timedOut",
  "budget-stop": "budgetStops",
};

interface Pair {
  a: { task: string; owner: string };
  b: { task: string; owner: string };
  conflicting: boolean;
}

/** Cross-owner pairs of tasks that changed a common file, deduplicated by the two task ids. */
function teammatePairs(input: CountsInput): Pair[] {
  const pairs = new Map<string, Pair>();
  const note = (a: { task: string; owner: string }, b: { task: string; owner: string }, conflicting: boolean) => {
    if (!a.task || !b.task || a.task === b.task || a.owner === b.owner) return; // teammates only
    const key = a.task < b.task ? `${a.task}|${b.task}` : `${b.task}|${a.task}`;
    const known = pairs.get(key);
    if (known) known.conflicting ||= conflicting;
    else pairs.set(key, { a, b, conflicting });
  };
  for (const b of input.briefings) {
    for (const s of json<Array<{ taskId?: string; withTaskId?: string; withOwner?: string }>>(b.shared_files, [])) {
      note({ task: String(s.taskId ?? ""), owner: String(b.owner) }, { task: String(s.withTaskId ?? ""), owner: String(s.withOwner ?? "") }, false);
    }
  }
  for (const c of input.conflicts) {
    note({ task: String(c.task_a), owner: String(c.owner_a) }, { task: String(c.task_b), owner: String(c.owner_b) }, true);
  }
  return [...pairs.values()];
}

export function computeCounts(input: CountsInput): RawCounts {
  const readyTasks = new Set<string>();
  for (const b of input.briefings) {
    for (const item of json<Array<{ taskId?: string; category?: string }>>(b.items, [])) {
      if (item.category === "ready" && item.taskId) readyTasks.add(item.taskId);
    }
  }

  const byKey = new Map<string, { owner: string; kind: string; counts: Counts }>();
  const bucket = (owner: string, kind: string) => {
    const key = `${owner}\u0000${kind}`;
    let b = byKey.get(key);
    if (!b) byKey.set(key, (b = { owner, kind, counts: zero() }));
    return b.counts;
  };

  const kindOf = new Map<string, { owner: string; kind: string }>();
  for (const e of input.events) {
    const taskId = String(e.task_id);
    const owner = String(e.owner);
    const kind = String(e.task_kind || "task");
    kindOf.set(taskId, { owner, kind });
    const c = bucket(owner, kind);
    if (e.approved_at) c.handedOver += 1;
    if (readyTasks.has(taskId)) c.ready += 1;
    if (e.outcome === "accepted") c.approved += 1;
    if (e.outcome === "rejected") c.rejected += 1;
    if (e.outcome === "failed") c.failed += 1;
    if (e.checks_result === "not-tested") c.notTested += 1;
    for (const flag of flagsOf(e, input.flags.get(taskId) ?? [])) {
      const column = FLAG_COLUMN[flag.kind];
      if (column) c[column] += 1;
    }
  }

  const team = zero();
  for (const b of byKey.values()) add(team, b.counts);
  // Pairs are not tasks: add them separately (the team once, each of the two people once).
  for (const pair of teammatePairs(input)) {
    team.teammateOverlaps += 1;
    if (pair.conflicting) team.wouldBeConflicts += 1;
    for (const side of [pair.a, pair.b]) {
      const known = kindOf.get(side.task);
      const owner = known?.owner ?? side.owner;
      const c = bucket(owner, known?.kind ?? "task");
      c.teammateOverlaps += 1;
      if (pair.conflicting) c.wouldBeConflicts += 1;
    }
  }

  const owners = [...new Set([...byKey.values()].map((b) => b.owner))].sort();
  const people = owners.map((owner) => {
    const kinds = [...byKey.values()]
      .filter((b) => b.owner === owner)
      .sort((x, y) => x.kind.localeCompare(y.kind))
      .map((b) => ({ kind: b.kind, counts: b.counts }));
    const all = zero();
    for (const k of kinds) add(all, k.counts);
    return { owner, all, kinds };
  });
  return { team, people };
}
