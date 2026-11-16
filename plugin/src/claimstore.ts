import type { PluginDatabaseClient } from "@paperclipai/plugin-sdk";
import type { OpenClaim, Overlap } from "./prehandover.js";

type Db = Pick<PluginDatabaseClient, "namespace" | "execute" | "query">;

const events = (db: Db) => `"${db.namespace}".task_events`;
const overlaps = (db: Db) => `"${db.namespace}".overlaps`;

function parseClaims(raw: unknown): string[] {
  try {
    const parsed = JSON.parse(String(raw ?? "[]"));
    return Array.isArray(parsed) ? parsed.filter((c): c is string => typeof c === "string") : [];
  } catch {
    return [];
  }
}

export async function recordClaims(db: Db, taskId: string, claims: string[]): Promise<void> {
  await db.execute(`UPDATE ${events(db)} SET claims = $1, updated_at = now() WHERE task_id = $2`, [JSON.stringify(claims), taskId]);
}

/** A task's claims end when the task is decided (an outcome) or its plan expired (released). */
export async function releaseClaims(db: Db, taskIds: string[]): Promise<void> {
  for (const taskId of taskIds) {
    await db.execute(`UPDATE ${events(db)} SET claims_released_at = now(), updated_at = now() WHERE task_id = $1`, [taskId]);
  }
}

/** Every task in the company that still holds claims. Titles come from the board. */
export async function openClaims(db: Db, companyId: string, titleOf: (taskId: string) => Promise<string>): Promise<OpenClaim[]> {
  const rows = await db.query(`SELECT * FROM ${events(db)} WHERE company_id = $1 AND outcome IS NULL AND claims_released_at IS NULL`, [companyId]);
  const result: OpenClaim[] = [];
  for (const row of rows) {
    const claims = parseClaims(row.claims);
    if (claims.length === 0) continue;
    const taskId = String(row.task_id);
    result.push({ taskId, owner: String(row.owner), title: await titleOf(taskId), claims });
  }
  return result;
}

export async function claimsOf(db: Db, taskId: string): Promise<string[]> {
  const rows = await db.query(`SELECT * FROM ${events(db)} WHERE task_id = $1`, [taskId]);
  return parseClaims(rows[0]?.claims);
}

export async function recordOverlap(
  db: Db,
  row: { id: string; companyId: string; handoverKey: string; owner: string; title: string; ticketId: string; overlap: Overlap },
): Promise<void> {
  const o = row.overlap;
  const against = o.kind === "area" ? `CODEOWNERS line ${o.rule.line}: ${o.rule.pattern}` : `${o.other.taskId}: ${o.otherClaim}`;
  await db.execute(
    `INSERT INTO ${overlaps(db)} (id, company_id, handover_key, owner, keeper, kind, task_title, claim, against, ticket_id) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) ON CONFLICT (id) DO NOTHING`,
    [row.id, row.companyId, row.handoverKey, row.owner, o.keeper.email, o.kind, row.title, o.claim, against, row.ticketId],
  );
}

export async function listOverlaps(db: Db, companyId: string): Promise<Array<Record<string, unknown>>> {
  return db.query(`SELECT * FROM ${overlaps(db)} WHERE company_id = $1 ORDER BY created_at`, [companyId]);
}
