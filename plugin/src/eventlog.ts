import type { PluginDatabaseClient } from "@paperclipai/plugin-sdk";

export type TaskOutcome = "accepted" | "rejected" | "blocked" | "failed";
export type ChecksResult = "passed" | "failed";

export interface TaskEventRow {
  taskId: string;
  companyId: string;
  owner: string;
  agent: string;
  taskKind: string;
}

type Db = Pick<PluginDatabaseClient, "namespace" | "execute" | "query">;

function table(db: Db): string {
  return `"${db.namespace}".task_events`;
}

/** Create the row for a task if it does not exist yet. Safe to call twice. */
export async function ensureTaskRow(db: Db, row: TaskEventRow): Promise<void> {
  await db.execute(
    `INSERT INTO ${table(db)} (task_id, company_id, owner, agent, task_kind) VALUES ($1, $2, $3, $4, $5) ON CONFLICT (task_id) DO NOTHING`,
    [row.taskId, row.companyId, row.owner, row.agent, row.taskKind],
  );
}

export async function recordHandoff(db: Db, row: TaskEventRow, handedOffTo: string): Promise<void> {
  await ensureTaskRow(db, row);
  await db.execute(`UPDATE ${table(db)} SET handed_off_to = $1, updated_at = now() WHERE task_id = $2`, [
    handedOffTo,
    row.taskId,
  ]);
}

/** Store the checks result together with the commit it was run on. */
export async function recordChecks(db: Db, taskId: string, result: ChecksResult, head: string | null): Promise<void> {
  await db.execute(`UPDATE ${table(db)} SET checks_result = $1, checks_head = $2, updated_at = now() WHERE task_id = $3`, [
    result,
    head,
    taskId,
  ]);
}

export async function getTaskRow(db: Db, taskId: string): Promise<Record<string, unknown> | null> {
  const rows = await db.query(`SELECT * FROM ${table(db)} WHERE task_id = $1`, [taskId]);
  return rows[0] ?? null;
}
