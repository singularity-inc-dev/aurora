import { createHash } from "node:crypto";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import type { ChecksSettings } from "./config.js";
import { redact } from "./secretscan.js";

/**
 * Save real handover tasks from the event log for the replay script (evals).
 *
 * A saved task is: the inputs (what the owner's ticket said), the repository
 * commit the work started from, and what became of it (checks result, outcome,
 * time). Only tasks the gate checked are saved, because only they have a
 * starting commit. A saved task is never changed afterwards.
 */

/** A replay compares prompts on 10 to 20 tasks; saving more than this at once is never useful. */
export const MAX_SAVE = 100;

export type SavedTaskRow = Record<string, unknown>;

/** What the replay script reads. Owner emails never leave the plugin: owners appear as short hashes. */
export interface ReplayTask {
  taskId: string;
  identifier: string | null;
  owner: string;
  taskKind: string;
  title: string;
  description: string;
  /** True when the ticket text held something that looked like a secret and was replaced. */
  inputsRedacted: boolean;
  /** True when Paperclip returned only part of the ticket text; such a task is not replayable. */
  descriptionTruncated: boolean;
  baseRef: string | null;
  baseSha: string;
  headSha: string;
  checksResult: string | null;
  outcome: string | null;
  rejectReason: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  /** Seconds from start to finish in the original run, when both are known. */
  durationSeconds: number | null;
}

export interface SaveResult {
  /** Saved by this call. */
  added: number;
  /** Candidates that could not be saved, with a plain reason (never ticket text). */
  skipped: Array<{ taskId: string; reason: string }>;
  tasks: ReplayTask[];
  /** The operator's checks settings, so the replay uses the same gate as production. */
  checks: Pick<ChecksSettings, "testCommand" | "lintCommand" | "maxDiffLines" | "timeoutSeconds">;
}

const SHA = /^[0-9a-f]{40}([0-9a-f]{24})?$/;
const str = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : v instanceof Date ? v.toISOString() : null);
const time = (v: unknown): number | null => {
  const s = str(v);
  return s ? new Date(s).getTime() : null;
};

/** A short, stable stand-in for an owner's email in the saved file. */
export function ownerTag(email: string): string {
  return `o-${createHash("sha256").update(email.toLowerCase()).digest("hex").slice(0, 8)}`;
}

function table(ctx: Pick<PluginContext, "db">, name: string): string {
  return `"${ctx.db.namespace}".${name}`;
}

function toReplayTask(row: SavedTaskRow): ReplayTask {
  const started = time(row.started_at);
  const finished = time(row.finished_at);
  return {
    taskId: String(row.task_id),
    identifier: str(row.identifier),
    owner: ownerTag(String(row.owner)),
    taskKind: String(row.task_kind),
    title: String(row.title),
    description: String(row.description ?? ""),
    inputsRedacted: row.inputs_redacted === true,
    descriptionTruncated: row.description_truncated === true,
    baseRef: str(row.base_ref),
    baseSha: String(row.base_sha),
    headSha: String(row.head_sha),
    checksResult: str(row.checks_result),
    outcome: str(row.outcome),
    rejectReason: str(row.reject_reason),
    startedAt: str(row.started_at),
    finishedAt: str(row.finished_at),
    durationSeconds: started !== null && finished !== null && finished >= started ? Math.round((finished - started) / 1000) : null,
  };
}

/** Newest finished first; tasks with no finish time sort by when their row last changed. */
function recency(row: SavedTaskRow): number {
  return time(row.finished_at) ?? time(row.updated_at) ?? 0;
}

export interface SaveOptions {
  /** How many saved tasks to return (newest first). */
  limit: number;
  /** Also save tasks nobody has decided yet (no outcome). Off by default: they have no ground truth. */
  includeUndecided: boolean;
}

export async function saveReplayTasks(
  ctx: Pick<PluginContext, "db" | "issues" | "executionWorkspaces">,
  companyId: string,
  checks: ChecksSettings,
  options: SaveOptions,
): Promise<SaveResult> {
  const limit = Math.max(1, Math.min(MAX_SAVE, Math.floor(options.limit)));
  const events = await ctx.db.query(`SELECT * FROM ${table(ctx, "task_events")} WHERE company_id = $1`, [companyId]);
  const saved = await ctx.db.query(`SELECT * FROM ${table(ctx, "saved_tasks")} WHERE company_id = $1`, [companyId]);
  const already = new Set(saved.map((r) => String(r.task_id)));

  const skipped: SaveResult["skipped"] = [];
  const candidates = events
    .filter((e) => !already.has(String(e.task_id)))
    .filter((e) => str(e.checks_head) && str(e.checks_base))
    .filter((e) => options.includeUndecided || str(e.outcome))
    .sort((a, b) => recency(b) - recency(a));

  let added = 0;
  // Only as many new rows as the caller can use; older candidates stay for a later call.
  for (const e of candidates.slice(0, limit)) {
    const taskId = String(e.task_id);
    const baseSha = String(e.checks_base);
    const headSha = String(e.checks_head);
    if (!SHA.test(baseSha) || !SHA.test(headSha)) {
      skipped.push({ taskId, reason: "the recorded commit is not a full commit id" });
      continue;
    }
    const issue = await ctx.issues.get(taskId, companyId).catch(() => null);
    if (!issue) {
      skipped.push({ taskId, reason: "the ticket is gone, so its inputs are lost" });
      continue;
    }
    const workspace = issue.executionWorkspaceId ? await ctx.executionWorkspaces.get(issue.executionWorkspaceId, companyId).catch(() => null) : null;
    // A secret pasted into a ticket must not end up in a file that is copied around.
    const description = redact(issue.description ?? "");
    const title = redact(issue.title);
    const inputsRedacted = description !== (issue.description ?? "") || title !== issue.title;
    const result = await ctx.db.execute(
      `INSERT INTO ${table(ctx, "saved_tasks")} (task_id, company_id, owner, agent, task_kind, identifier, title, description, inputs_redacted, description_truncated, base_ref, base_sha, head_sha, repo_url, checks_result, outcome, reject_reason, started_at, finished_at) ` +
        `VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19) ON CONFLICT (task_id) DO NOTHING`,
      [
        taskId,
        companyId,
        String(e.owner),
        String(e.agent),
        String(e.task_kind),
        issue.identifier ?? null,
        title,
        description,
        inputsRedacted,
        issue.descriptionTruncated === true,
        workspace?.baseRef ?? null,
        baseSha,
        headSha,
        workspace?.repoUrl ?? null,
        str(e.checks_result),
        str(e.outcome),
        str(e.reject_reason),
        str(e.started_at),
        str(e.finished_at),
      ],
    );
    added += result.rowCount > 0 ? 1 : 0;
  }

  const all = await ctx.db.query(`SELECT * FROM ${table(ctx, "saved_tasks")} WHERE company_id = $1`, [companyId]);
  const tasks = all
    .sort((a, b) => (time(b.finished_at) ?? time(b.saved_at) ?? 0) - (time(a.finished_at) ?? time(a.saved_at) ?? 0))
    .slice(0, limit)
    .map(toReplayTask);
  return {
    added,
    skipped,
    tasks,
    checks: { testCommand: checks.testCommand, lintCommand: checks.lintCommand, maxDiffLines: checks.maxDiffLines, timeoutSeconds: checks.timeoutSeconds },
  };
}
