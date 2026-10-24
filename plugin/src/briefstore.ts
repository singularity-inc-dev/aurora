import { randomUUID } from "node:crypto";
import type { PluginDatabaseClient } from "@paperclipai/plugin-sdk";
import type { LinkKind } from "./tokens.js";

type Db = Pick<PluginDatabaseClient, "namespace" | "execute" | "query">;
const t = (db: Db, name: string) => `"${db.namespace}".${name}`;

export type Category = "ready" | "blocked" | "failed" | "waiting";

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
  /** Pull request waiting for review on GitHub (category "waiting"). */
  prUrl?: string | null;
  /** Listed in an earlier email and still undecided. */
  carried?: boolean;
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

/** A pull request opened by an Approve link (GitHub mode). */
export interface PullRequestRow {
  taskId: string;
  companyId: string;
  owner: string;
  actionId: string;
  number: number;
  url: string;
  headSha: string;
  state: "waiting" | "merged" | "closed";
  reason: string | null;
}

function toPullRequest(r: Record<string, unknown>): PullRequestRow {
  return {
    taskId: String(r.task_id),
    companyId: String(r.company_id),
    owner: String(r.owner),
    actionId: String(r.action_id),
    number: Number(r.number),
    url: String(r.url),
    headSha: String(r.head_sha),
    state: String(r.state) as PullRequestRow["state"],
    reason: (r.reason as string | null) ?? null,
  };
}

export async function getPullRequest(db: Db, taskId: string): Promise<PullRequestRow | null> {
  const rows = await db.query(`SELECT * FROM ${t(db, "pull_requests")} WHERE task_id = $1`, [taskId]);
  return rows[0] ? toPullRequest(rows[0]) : null;
}

export async function listWaitingPullRequests(db: Db, companyId: string): Promise<PullRequestRow[]> {
  const rows = await db.query(`SELECT * FROM ${t(db, "pull_requests")} WHERE company_id = $1 AND state = 'waiting' LIMIT 100`, [companyId]);
  return rows.map(toPullRequest);
}

export async function insertWaitingPullRequest(db: Db, pr: Omit<PullRequestRow, "state">): Promise<void> {
  await db.execute(
    `INSERT INTO ${t(db, "pull_requests")} (task_id, company_id, owner, action_id, number, url, head_sha, reason) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [pr.taskId, pr.companyId, pr.owner, pr.actionId, pr.number, pr.url, pr.headSha, pr.reason],
  );
}

/** Close a waiting pull request row; only the first update wins. */
export async function closePullRequest(db: Db, taskId: string, state: "merged" | "closed", mergeSha: string | null): Promise<boolean> {
  const { rowCount } = await db.execute(
    `UPDATE ${t(db, "pull_requests")} SET state = $1, merge_sha = $2, updated_at = now() WHERE task_id = $3 AND state = 'waiting'`,
    [state, mergeSha, taskId],
  );
  return rowCount === 1;
}

/** Task ids listed in this person's earlier briefings (newest first), for carrying undecided tasks over. */
export async function earlierBriefingTaskIds(db: Db, companyId: string, owner: string, beforeNightDate: string): Promise<string[]> {
  const rows = await db.query(
    `SELECT * FROM ${t(db, "briefings")} WHERE company_id = $1 AND owner = $2 ORDER BY night_date DESC LIMIT 30`,
    [companyId, owner],
  );
  const ids: string[] = [];
  for (const r of rows) {
    if (String(r.night_date) >= beforeNightDate) continue;
    for (const item of json<BriefingItem[]>(r.items, [])) if (!ids.includes(item.taskId)) ids.push(item.taskId);
  }
  return ids;
}
