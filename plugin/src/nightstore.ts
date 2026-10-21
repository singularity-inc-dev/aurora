import type { PluginDatabaseClient } from "@paperclipai/plugin-sdk";
import { OPEN_STATUSES, type NightRun, type NightStatus } from "./night.js";

type Db = Pick<PluginDatabaseClient, "namespace" | "execute" | "query">;

const table = (db: Db) => `"${db.namespace}".night_runs`;
const events = (db: Db) => `"${db.namespace}".task_events`;

function toRun(row: Record<string, unknown>): NightRun {
  let taskIds: string[] = [];
  try {
    const parsed = JSON.parse(String(row.task_ids ?? "[]"));
    if (Array.isArray(parsed)) taskIds = parsed.filter((x): x is string => typeof x === "string");
  } catch {
    taskIds = [];
  }
  return {
    companyId: String(row.company_id),
    owner: String(row.owner),
    agentId: String(row.agent_id),
    nightDate: String(row.night_date),
    status: String(row.status) as NightStatus,
    planIssueId: (row.plan_issue_id as string | null) ?? null,
    interactionId: (row.interaction_id as string | null) ?? null,
    taskIds,
    currentIndex: Number(row.current_index ?? -1),
    currentAttempt: Number(row.current_attempt ?? 0),
    stepStartedAt: row.step_started_at ? new Date(String(row.step_started_at)) : null,
    stopReason: (row.stop_reason as string | null) ?? null,
  };
}

/** The person's newest night that is still in progress, if any. */
export async function getOpenRun(db: Db, companyId: string, owner: string): Promise<NightRun | null> {
  const rows = await db.query(
    `SELECT * FROM ${table(db)} WHERE company_id = $1 AND owner = $2 AND status IN ('${OPEN_STATUSES.join("','")}') ORDER BY night_date DESC LIMIT 1`,
    [companyId, owner],
  );
  return rows[0] ? toRun(rows[0]) : null;
}

export async function getRun(db: Db, companyId: string, owner: string, nightDate: string): Promise<NightRun | null> {
  const rows = await db.query(`SELECT * FROM ${table(db)} WHERE company_id = $1 AND owner = $2 AND night_date = $3`, [
    companyId,
    owner,
    nightDate,
  ]);
  return rows[0] ? toRun(rows[0]) : null;
}

export async function listRuns(db: Db, companyId: string, limit = 50): Promise<NightRun[]> {
  const rows = await db.query(`SELECT * FROM ${table(db)} WHERE company_id = $1 ORDER BY night_date DESC, owner LIMIT ${Math.trunc(limit)}`, [
    companyId,
  ]);
  return rows.map(toRun);
}

/** Claim tonight's routine for a person. Returns false if one already exists. */
export async function claimRun(db: Db, run: Pick<NightRun, "companyId" | "owner" | "agentId" | "nightDate">): Promise<boolean> {
  const { rowCount } = await db.execute(
    `INSERT INTO ${table(db)} (company_id, owner, agent_id, night_date, status) VALUES ($1, $2, $3, $4, 'proposing') ON CONFLICT (company_id, owner, night_date) DO NOTHING`,
    [run.companyId, run.owner, run.agentId, run.nightDate],
  );
  return rowCount === 1;
}

export interface RunPatch {
  status?: NightStatus;
  planIssueId?: string;
  interactionId?: string;
  taskIds?: string[];
  currentIndex?: number;
  currentAttempt?: number;
  stepStartedAt?: Date;
  stopReason?: string;
}

const COLUMNS: Record<keyof RunPatch, string> = {
  status: "status",
  planIssueId: "plan_issue_id",
  interactionId: "interaction_id",
  taskIds: "task_ids",
  currentIndex: "current_index",
  currentAttempt: "current_attempt",
  stepStartedAt: "step_started_at",
  stopReason: "stop_reason",
};

/**
 * Move a run on, but only if it is still in the state we decided from
 * (status and step). Returns false when another tick got there first.
 */
export async function updateRun(db: Db, run: NightRun, patch: RunPatch): Promise<boolean> {
  const sets: string[] = [];
  const params: unknown[] = [];
  for (const [key, column] of Object.entries(COLUMNS) as Array<[keyof RunPatch, string]>) {
    const value = patch[key];
    if (value === undefined) continue;
    params.push(key === "taskIds" ? JSON.stringify(value) : value instanceof Date ? value.toISOString() : value);
    sets.push(`${column} = $${params.length}`);
  }
  params.push(run.companyId, run.owner, run.nightDate, run.status, run.currentIndex, run.currentAttempt);
  const n = params.length;
  const { rowCount } = await db.execute(
    `UPDATE ${table(db)} SET ${sets.join(", ")}, updated_at = now() WHERE company_id = $${n - 5} AND owner = $${n - 4} AND night_date = $${n - 3} AND status = $${n - 2} AND current_index = $${n - 1} AND current_attempt = $${n}`,
    params,
  );
  return rowCount === 1;
}

/** Cost recorded for an agent since a moment, in cents (Paperclip's cost_events). */
export async function spentSince(db: Db, companyId: string, agentId: string, since: Date): Promise<number> {
  const rows = await db.query<{ spent: number | string | null }>(
    `SELECT COALESCE(SUM(cost_cents), 0) AS spent FROM public.cost_events WHERE company_id = $1 AND agent_id = $2 AND occurred_at >= $3`,
    [companyId, agentId, since.toISOString()],
  );
  return Number(rows[0]?.spent ?? 0);
}

type EventColumn = "proposed_at" | "approved_at" | "started_at" | "finished_at";

/** Stamp a time column on task rows; keeps an earlier stamp if there is one. */
export async function stampTasks(db: Db, taskIds: string[], column: EventColumn, at: Date): Promise<void> {
  for (const taskId of taskIds) {
    await db.execute(`UPDATE ${events(db)} SET ${column} = COALESCE(${column}, $1), updated_at = now() WHERE task_id = $2`, [
      at.toISOString(),
      taskId,
    ]);
  }
}

export async function setTaskOutcome(db: Db, taskId: string, outcome: "rejected" | "blocked" | "failed", rejectReason: string | null): Promise<void> {
  await db.execute(`UPDATE ${events(db)} SET outcome = $1, reject_reason = $2, updated_at = now() WHERE task_id = $3`, [
    outcome,
    rejectReason,
    taskId,
  ]);
}
