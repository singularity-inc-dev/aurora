import type { PluginDatabaseClient } from "@paperclipai/plugin-sdk";
import { cleanDetail, STORED_FLAGS, type RunFlag, type StoredFlagKind } from "./flags.js";

type Db = Pick<PluginDatabaseClient, "namespace" | "execute" | "query">;
const table = (db: Db) => `"${db.namespace}".run_flags`;

/** Write a flag. A second one of the same kind on the same task keeps one row and updates its detail. */
export async function recordFlag(db: Db, companyId: string, taskId: string, kind: StoredFlagKind, detail: string | null): Promise<void> {
  await db.execute(`INSERT INTO ${table(db)} (task_id, company_id, kind, detail) VALUES ($1, $2, $3, $4) ON CONFLICT (task_id, kind) DO NOTHING`, [
    taskId,
    companyId,
    kind,
    cleanDetail(detail),
  ]);
  await db.execute(`UPDATE ${table(db)} SET detail = $1, updated_at = now() WHERE task_id = $2 AND kind = $3`, [cleanDetail(detail), taskId, kind]);
}

/**
 * Same as recordFlag, but never throws: a failure to write a flag must not hide
 * the error or the stop that the flag describes. Returns whether it was written.
 */
export async function recordFlagSafely(
  db: Db,
  companyId: string,
  taskId: string,
  kind: StoredFlagKind,
  detail: string | null,
  onError?: (message: string) => void,
): Promise<boolean> {
  try {
    await recordFlag(db, companyId, taskId, kind, detail);
    return true;
  } catch (err) {
    onError?.(`could not record run flag ${kind}: ${err instanceof Error ? err.message : "unknown error"}`);
    return false;
  }
}

const isStored = (kind: unknown): kind is StoredFlagKind => (STORED_FLAGS as readonly unknown[]).includes(kind);

function toFlag(row: Record<string, unknown>): RunFlag | null {
  return isStored(row.kind) ? { kind: row.kind, detail: typeof row.detail === "string" ? row.detail : null } : null;
}

export async function listFlagsForTask(db: Db, taskId: string): Promise<RunFlag[]> {
  const rows = await db.query(`SELECT * FROM ${table(db)} WHERE task_id = $1`, [taskId]);
  return rows.map(toFlag).filter((f): f is RunFlag => f !== null);
}

/** Every stored flag in a company, by task id. */
export async function listFlagsForCompany(db: Db, companyId: string): Promise<Map<string, RunFlag[]>> {
  const rows = await db.query(`SELECT * FROM ${table(db)} WHERE company_id = $1`, [companyId]);
  const byTask = new Map<string, RunFlag[]>();
  for (const row of rows) {
    const flag = toFlag(row);
    if (flag) byTask.set(String(row.task_id), [...(byTask.get(String(row.task_id)) ?? []), flag]);
  }
  return byTask;
}
