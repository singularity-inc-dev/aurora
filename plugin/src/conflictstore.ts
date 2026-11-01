import type { PluginDatabaseClient } from "@paperclipai/plugin-sdk";
import type { Conflict } from "./replay.js";

type Db = Pick<PluginDatabaseClient, "namespace" | "execute" | "query">;
const table = (db: Db) => `"${db.namespace}".conflicts`;

/**
 * Record a conflict once per pair of branch versions (the pair in a fixed order).
 * Returns true only the first time, so each conflict is announced once.
 */
export async function recordConflict(db: Db, companyId: string, c: Conflict): Promise<boolean> {
  const [x, y] = c.a.taskId < c.b.taskId ? [c.a, c.b] : [c.b, c.a];
  const { rowCount } = await db.execute(
    `INSERT INTO ${table(db)} (company_id, task_a, task_b, head_a, head_b, owner_a, owner_b, files) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) ON CONFLICT (company_id, task_a, task_b, head_a, head_b) DO NOTHING`,
    [companyId, x.taskId, y.taskId, x.head, y.head, x.owner, y.owner, JSON.stringify(c.files)],
  );
  return rowCount === 1;
}

export async function listConflicts(db: Db, companyId: string): Promise<Array<Record<string, unknown>>> {
  return db.query(`SELECT * FROM ${table(db)} WHERE company_id = $1 ORDER BY created_at`, [companyId]);
}
