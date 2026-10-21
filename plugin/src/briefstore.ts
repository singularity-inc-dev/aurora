import { randomUUID } from "node:crypto";
import type { PluginDatabaseClient } from "@paperclipai/plugin-sdk";
import type { LinkKind } from "./tokens.js";

type Db = Pick<PluginDatabaseClient, "namespace" | "execute" | "query">;
const t = (db: Db, name: string) => `"${db.namespace}".${name}`;

export type Category = "ready" | "blocked" | "failed";

export interface BriefingItem {
  taskId: string;
  identifier: string | null;
  title: string;
  category: Category;
  /** One line: what changed. */
  summary: string;
  checks: string;
  reason: string | null;
  approveActionId: string | null;
  rejectActionId: string | null;
}

export interface Briefing {
  id: string;
  companyId: string;
  owner: string;
  nightDate: string;
  status: "pending" | "sent";
  items: BriefingItem[];
  notes: string[];
}

export interface LinkAction {
  id: string;
  companyId: string;
  owner: string;
  taskId: string;
  kind: LinkKind;
  briefingId: string;
  workspaceCwd: string | null;
  branch: string | null;
  baseRef: string | null;
  expectedHead: string | null;
  expiresAt: Date;
  state: "new" | "processing" | "done" | "refused";
  result: string | null;
}

const json = <T>(v: unknown, fallback: T): T => {
  try {
    return JSON.parse(String(v)) as T;
  } catch {
    return fallback;
  }
};

function toBriefing(r: Record<string, unknown>): Briefing {
  return {
    id: String(r.id),
    companyId: String(r.company_id),
    owner: String(r.owner),
    nightDate: String(r.night_date),
    status: r.status === "sent" ? "sent" : "pending",
    items: json<BriefingItem[]>(r.items, []),
    notes: json<string[]>(r.notes, []),
  };
}

function toAction(r: Record<string, unknown>): LinkAction {
  return {
    id: String(r.id),
    companyId: String(r.company_id),
    owner: String(r.owner),
    taskId: String(r.task_id),
    kind: r.kind === "approve" ? "approve" : "reject",
    briefingId: String(r.briefing_id),
    workspaceCwd: (r.workspace_cwd as string | null) ?? null,
    branch: (r.branch as string | null) ?? null,
    baseRef: (r.base_ref as string | null) ?? null,
    expectedHead: (r.expected_head as string | null) ?? null,
    expiresAt: new Date(String(r.expires_at)),
    state: String(r.state) as LinkAction["state"],
    result: (r.result as string | null) ?? null,
  };
}

export const newId = () => randomUUID();

export async function getBriefing(db: Db, companyId: string, owner: string, nightDate: string): Promise<Briefing | null> {
  const rows = await db.query(`SELECT * FROM ${t(db, "briefings")} WHERE company_id = $1 AND owner = $2 AND night_date = $3`, [companyId, owner, nightDate]);
  return rows[0] ? toBriefing(rows[0]) : null;
}

export async function getBriefingById(db: Db, companyId: string, id: string): Promise<Briefing | null> {
  const rows = await db.query(`SELECT * FROM ${t(db, "briefings")} WHERE company_id = $1 AND id = $2`, [companyId, id]);
  return rows[0] ? toBriefing(rows[0]) : null;
}

export async function listPendingBriefings(db: Db, companyId: string): Promise<Briefing[]> {
  const rows = await db.query(`SELECT * FROM ${t(db, "briefings")} WHERE company_id = $1 AND status = 'pending' ORDER BY night_date LIMIT 50`, [companyId]);
  return rows.map(toBriefing);
}

/** Insert the briefing; returns false if one already exists for this person and night. */
export async function insertBriefing(db: Db, b: Omit<Briefing, "status">): Promise<boolean> {
  const { rowCount } = await db.execute(
    `INSERT INTO ${t(db, "briefings")} (id, company_id, owner, night_date, items, notes) VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (company_id, owner, night_date) DO NOTHING`,
    [b.id, b.companyId, b.owner, b.nightDate, JSON.stringify(b.items), JSON.stringify(b.notes)],
  );
  return rowCount === 1;
}

export async function markBriefingSent(db: Db, companyId: string, id: string): Promise<boolean> {
  const { rowCount } = await db.execute(
    `UPDATE ${t(db, "briefings")} SET status = 'sent', sent_at = now() WHERE company_id = $1 AND id = $2 AND status = 'pending'`,
    [companyId, id],
  );
  return rowCount === 1;
}

export async function insertAction(db: Db, a: Omit<LinkAction, "state" | "result">): Promise<void> {
  await db.execute(
    `INSERT INTO ${t(db, "link_actions")} (id, company_id, owner, task_id, kind, briefing_id, workspace_cwd, branch, base_ref, expected_head, expires_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
    [a.id, a.companyId, a.owner, a.taskId, a.kind, a.briefingId, a.workspaceCwd, a.branch, a.baseRef, a.expectedHead, a.expiresAt.toISOString()],
  );
}

export async function getAction(db: Db, id: string): Promise<LinkAction | null> {
  const rows = await db.query(`SELECT * FROM ${t(db, "link_actions")} WHERE id = $1`, [id]);
  return rows[0] ? toAction(rows[0]) : null;
}

/** Atomically take a fresh link for processing. Only one click ever gets true. */
export async function claimAction(db: Db, id: string): Promise<boolean> {
  const { rowCount } = await db.execute(
    `UPDATE ${t(db, "link_actions")} SET state = 'processing', used_at = now() WHERE id = $1 AND state = 'new'`,
    [id],
  );
  return rowCount === 1;
}

export async function finishAction(db: Db, id: string, state: "done" | "refused", result: string): Promise<void> {
  await db.execute(`UPDATE ${t(db, "link_actions")} SET state = $1, result = $2 WHERE id = $3`, [state, result, id]);
}

/** Outcomes a link may still decide: approve needs an undecided task; reject may also close a blocked or failed one. */
export const DECIDABLE: Record<"approve" | "reject", ReadonlyArray<string | null>> = {
  approve: [null],
  reject: [null, "blocked", "failed"],
};

/**
 * Atomically make this link the one decision for its task (approve and reject
 * exclude each other). `currentOutcome` is what the caller read; the update only
 * applies if it is still the same.
 */
export async function claimDecision(db: Db, taskId: string, actionId: string, currentOutcome: string | null): Promise<boolean> {
  const { rowCount } =
    currentOutcome === null
      ? await db.execute(
          `UPDATE ${t(db, "task_events")} SET decision_action_id = $1, updated_at = now() WHERE task_id = $2 AND decision_action_id IS NULL AND outcome IS NULL`,
          [actionId, taskId],
        )
      : await db.execute(
          `UPDATE ${t(db, "task_events")} SET decision_action_id = $1, updated_at = now() WHERE task_id = $2 AND decision_action_id IS NULL AND outcome = $3`,
          [actionId, taskId, currentOutcome],
        );
  return rowCount === 1;
}

export async function releaseDecision(db: Db, taskId: string, actionId: string): Promise<void> {
  await db.execute(`UPDATE ${t(db, "task_events")} SET decision_action_id = NULL, updated_at = now() WHERE task_id = $1 AND decision_action_id = $2`, [
    taskId,
    actionId,
  ]);
}

export async function setDecisionOutcome(db: Db, taskId: string, outcome: "accepted" | "rejected", rejectReason: string | null): Promise<void> {
  await db.execute(`UPDATE ${t(db, "task_events")} SET outcome = $1, reject_reason = $2, updated_at = now() WHERE task_id = $3`, [
    outcome,
    rejectReason,
    taskId,
  ]);
}
