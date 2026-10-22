import type { PluginContext } from "@paperclipai/plugin-sdk";
import {
  claimAction,
  claimDecision,
  closePullRequest,
  DECIDABLE,
  finishAction,
  getAction,
  getPullRequest,
  insertWaitingPullRequest,
  releaseDecision,
  setDecisionOutcome,
  type LinkAction,
} from "./briefstore.js";
import { findPersonByEmail, type PluginSettings } from "./config.js";
import { getTaskRow } from "./eventlog.js";
import { mergeApproved, revParse } from "./merge.js";
import { assertTier, TierRefused } from "./tiers.js";
import { verifyLink, type LinkClaims } from "./tokens.js";

export const MAX_REASON_LENGTH = 200;

export type LinkOutcome =
  | { ok: true; status: "merged" | "rejected" | "waiting"; message: string }
  | { ok: true; status: "publish"; message: string; publish: PublishRequest }
  | { ok: false; status: "invalid" | "expired" | "already-used" | "refused" | "needs-reason"; message: string };

/**
 * What the email service must do for an approved task in GitHub mode: push
 * exactly `expectedHead` as `branch`, open a pull request into `baseBranch`
 * and squash-merge it. Only the email service holds the GitHub token.
 */
export interface PublishRequest {
  repo: string;
  /** A checkout that has the task branch (the task's worktree). */
  worktree: string;
  branch: string;
  baseBranch: string;
  expectedHead: string;
  title: string;
  body: string;
}

/** "refs/heads/main" or "origin/main" -> "main". */
export function baseBranchName(ref: string): string {
  return ref.replace(/^refs\/heads\//, "").replace(/^refs\/remotes\/origin\//, "").replace(/^origin\//, "");
}

export interface LinkCheck {
  ok: boolean;
  status: "valid" | "invalid" | "expired" | "already-used";
  message: string;
  kind?: "approve" | "reject";
  task?: { identifier: string | null; title: string };
  /** Set when Approve publishes to GitHub ("owner/name"). */
  github?: string;
}

const INVALID = { ok: false as const, status: "invalid" as const, message: "This link is not valid." };

/** Every check that does not change anything: signature, expiry, database match, owner binding. */
async function authenticate(
  ctx: PluginContext,
  settings: PluginSettings,
  companyId: string,
  token: string,
  now: Date,
  opts: { allowExpired?: boolean } = {},
): Promise<{ ok: true; claims: LinkClaims; action: LinkAction } | { ok: false; status: "invalid" | "expired"; message: string }> {
  if (!settings.links) return INVALID;
  const secret = await ctx.secrets.resolve(settings.links.signingSecret, { companyId });
  // Reporting a publish result may arrive seconds after expiry; the action row still has to be in progress.
  const v = verifyLink(token, secret, opts.allowExpired ? new Date(0) : now);
  if (!v.ok) return v.reason === "expired" ? { ok: false, status: "expired", message: "This link has expired." } : INVALID;
  const c = v.claims;
  if (c.c !== companyId) return INVALID;
  const action = await getAction(ctx.db, c.a);
  // The signed claims must match the stored link exactly: a link for one
  // person's task can never act on another task or for another person.
  if (!action || action.companyId !== c.c || action.owner !== c.o || action.taskId !== c.t || action.kind !== c.k) return INVALID;
  if (!opts.allowExpired && action.expiresAt.getTime() <= now.getTime()) return { ok: false, status: "expired", message: "This link has expired." };
  const person = findPersonByEmail(settings, c.o);
  const ev = await getTaskRow(ctx.db, c.t);
  if (!person || !ev || ev.owner !== c.o) return INVALID;
  return { ok: true, claims: c, action };
}

export async function previewLink(ctx: PluginContext, settings: PluginSettings, companyId: string, token: string, now: Date): Promise<LinkCheck> {
  const auth = await authenticate(ctx, settings, companyId, token, now);
  if (!auth.ok) return { ok: false, status: auth.status, message: auth.message };
  const issue = await ctx.issues.get(auth.claims.t, companyId);
  const task = { identifier: issue?.identifier ?? null, title: issue?.title ?? "(missing ticket)" };
  if (auth.action.state !== "new") {
    return { ok: false, status: "already-used", message: `This link was already used: ${auth.action.result ?? "in progress"}.`, kind: auth.claims.k, task };
  }
  return { ok: true, status: "valid", message: "ok", kind: auth.claims.k, task, ...(settings.github && auth.claims.k === "approve" ? { github: settings.github.repo } : {}) };
}

/** Normalise a reject reason to one line; null if empty or too long. */
export function oneLineReason(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const line = raw.replace(/\s+/g, " ").trim();
  return line.length > 0 && line.length <= MAX_REASON_LENGTH ? line : null;
}

export async function executeLink(
  ctx: PluginContext,
  settings: PluginSettings,
  companyId: string,
  token: string,
  rawReason: unknown,
  now: Date,
): Promise<LinkOutcome> {
  const auth = await authenticate(ctx, settings, companyId, token, now);
  if (!auth.ok) return auth;
  const { claims, action } = auth;
  try {
    assertTier(claims.k === "approve" ? "merge-task" : "reject-task", "needs-tap");
  } catch (err) {
    if (err instanceof TierRefused) return { ok: false, status: "refused", message: err.message };
    throw err;
  }

  // Ask for the reason before using up the link.
  const reason = claims.k === "reject" ? oneLineReason(rawReason) : null;
  if (claims.k === "reject" && !reason) {
    return { ok: false, status: "needs-reason", message: `Please give a one-line reason (up to ${MAX_REASON_LENGTH} characters).` };
  }

  // Idempotency: only the first click gets past this line.
  if (!(await claimAction(ctx.db, action.id))) {
    const current = await getAction(ctx.db, action.id);
    return { ok: false, status: "already-used", message: `This link was already used: ${current?.result ?? "in progress"}.` };
  }
  const current = ((await getTaskRow(ctx.db, claims.t))?.outcome as string | null | undefined) ?? null;
  if (!DECIDABLE[claims.k].includes(current) || !(await claimDecision(ctx.db, claims.t, action.id, current))) {
    await finishAction(ctx.db, action.id, "refused", "the task was already approved or rejected");
    return { ok: false, status: "refused", message: "This task was already approved or rejected." };
  }

  const issue = await ctx.issues.get(claims.t, companyId);
  const name = issue?.identifier ?? claims.t;

  if (claims.k === "reject") {
    await setDecisionOutcome(ctx.db, claims.t, "rejected", reason);
    if (issue) {
      await ctx.issues.update(claims.t, { status: "cancelled" }, companyId);
      await ctx.issues.createComment(claims.t, `Rejected by ${claims.o} from the morning email: ${reason}`, companyId);
    }
    await finishAction(ctx.db, action.id, "done", `rejected: ${reason}`);
    return { ok: true, status: "rejected", message: `${name} was rejected. Reason saved.` };
  }

  // Approve: version check and merge.
  if (!action.workspaceCwd || !action.branch || !action.baseRef || !action.expectedHead) {
    await releaseDecision(ctx.db, claims.t, action.id);
    await finishAction(ctx.db, action.id, "refused", "nothing to merge");
    return { ok: false, status: "refused", message: "There is nothing to merge for this task." };
  }
  if (settings.github) {
    // Version check here too; the email service checks it again when fetching and GitHub a third time when merging.
    const head = await revParse(action.workspaceCwd, `refs/heads/${action.branch}`);
    if (head !== action.expectedHead) {
      await releaseDecision(ctx.db, claims.t, action.id);
      await finishAction(ctx.db, action.id, "refused", "the branch changed after the email was sent");
      return { ok: false, status: "refused", message: "Not merged: the branch changed after the email was sent." };
    }
    assertTier("publish-to-github", "needs-tap");
    return {
      ok: true,
      status: "publish",
      message: "publish to GitHub",
      publish: {
        repo: settings.github.repo,
        worktree: action.workspaceCwd,
        branch: action.branch,
        baseBranch: baseBranchName(action.baseRef),
        expectedHead: action.expectedHead,
        title: `${name}: ${issue?.title ?? "night task"}`,
        body: `Approved by ${claims.o} from the Vision and Tom morning email.\n\nTask ${name}, branch ${action.branch} at ${action.expectedHead}.`,
      },
    };
  }
  const merge = await mergeApproved({
    cwd: action.workspaceCwd,
    branch: action.branch,
    baseRef: action.baseRef,
    expectedHead: action.expectedHead,
    message: `Merge ${name}: ${issue?.title ?? ""} (approved by ${claims.o} via Vision and Tom)`,
  });
  if (!merge.ok) {
    await releaseDecision(ctx.db, claims.t, action.id);
    await finishAction(ctx.db, action.id, "refused", merge.message);
    return { ok: false, status: "refused", message: `Not merged: ${merge.message}.` };
  }
  await setDecisionOutcome(ctx.db, claims.t, "accepted", null);
  if (issue) {
    await ctx.issues.update(claims.t, { status: "done" }, companyId);
    await ctx.issues.createComment(
      claims.t,
      `Approved by ${claims.o} from the morning email. Merged ${action.branch} at ${action.expectedHead.slice(0, 7)} into ${action.baseRef} (${merge.mergeSha.slice(0, 7)}).`,
      companyId,
    );
  }
  await finishAction(ctx.db, action.id, "done", `merged into ${action.baseRef} as ${merge.mergeSha.slice(0, 7)}`);
  return { ok: true, status: "merged", message: `${name} was merged into ${action.baseRef}.` };
}

const SHA_RE = /^[0-9a-f]{7,64}$/;

/**
 * The email service reports what happened on GitHub for a link that returned
 * "publish". Only the link that holds the task's decision can report.
 */
export async function recordPublishResult(
  ctx: PluginContext,
  settings: PluginSettings,
  companyId: string,
  token: string,
  raw: Record<string, unknown>,
  now: Date,
): Promise<LinkOutcome> {
  const auth = await authenticate(ctx, settings, companyId, token, now, { allowExpired: true });
  if (!auth.ok) return auth;
  const { claims, action } = auth;
  const ev = await getTaskRow(ctx.db, claims.t);
  if (claims.k !== "approve" || action.state !== "processing" || ev?.decision_action_id !== action.id) {
    return { ok: false, status: "refused", message: "This approval is not in progress." };
  }
  const issue = await ctx.issues.get(claims.t, companyId);
  const name = issue?.identifier ?? claims.t;
  const number = Number(raw.number);
  const url = typeof raw.url === "string" && /^https?:\/\//.test(raw.url) ? raw.url : null;
  const hasPr = Number.isInteger(number) && number > 0 && url !== null;

  if (raw.result === "merged" && hasPr) {
    const mergeSha = typeof raw.mergeSha === "string" && SHA_RE.test(raw.mergeSha) ? raw.mergeSha : null;
    await insertWaitingPullRequest(ctx.db, { taskId: claims.t, companyId, owner: claims.o, actionId: action.id, number, url, headSha: action.expectedHead ?? "", reason: null });
    await closePullRequest(ctx.db, claims.t, "merged", mergeSha);
    await setDecisionOutcome(ctx.db, claims.t, "accepted", null);
    if (issue) {
      await ctx.issues.update(claims.t, { status: "done" }, companyId);
      await ctx.issues.createComment(claims.t, `Approved by ${claims.o} from the morning email. Pull request #${number} was squash-merged on GitHub: ${url}`, companyId);
    }
    await finishAction(ctx.db, action.id, "done", `merged on GitHub: pull request #${number}`);
    return { ok: true, status: "merged", message: `${name} was merged on GitHub (pull request #${number}).` };
  }
  if (raw.result === "waiting" && hasPr) {
    const reason = typeof raw.reason === "string" && raw.reason.trim() ? raw.reason.replace(/\s+/g, " ").trim().slice(0, 200) : "branch protection requires a review";
    await insertWaitingPullRequest(ctx.db, { taskId: claims.t, companyId, owner: claims.o, actionId: action.id, number, url, headSha: action.expectedHead ?? "", reason });
    if (issue) {
      await ctx.issues.update(claims.t, { status: "in_review" }, companyId);
      await ctx.issues.createComment(claims.t, `Approved by ${claims.o}. Pull request #${number} is waiting for review on GitHub (${reason}): ${url}`, companyId);
    }
    await finishAction(ctx.db, action.id, "done", `waiting for review: pull request #${number}`);
    return { ok: true, status: "waiting", message: `${name}: pull request #${number} is waiting for review on GitHub (${reason}). ${url}` };
  }
  const message = typeof raw.message === "string" && raw.message.trim() ? raw.message.replace(/\s+/g, " ").trim().slice(0, 200) : "GitHub did not accept the change";
  await releaseDecision(ctx.db, claims.t, action.id);
  await finishAction(ctx.db, action.id, "refused", message);
  return { ok: false, status: "refused", message: `Not merged: ${message}.` };
}

/** A waiting pull request was merged or closed on GitHub (reported by the email service's sync). */
export async function recordPullRequestUpdate(
  ctx: PluginContext,
  companyId: string,
  raw: Record<string, unknown>,
): Promise<{ ok: boolean; message: string }> {
  const taskId = typeof raw.taskId === "string" ? raw.taskId : "";
  const pr = taskId ? await getPullRequest(ctx.db, taskId) : null;
  if (!pr || pr.companyId !== companyId || pr.state !== "waiting") return { ok: false, message: "no waiting pull request for this task" };
  if (raw.state !== "merged" && raw.state !== "closed") return { ok: false, message: "state must be merged or closed" };
  const mergeSha = typeof raw.mergeSha === "string" && SHA_RE.test(raw.mergeSha) ? raw.mergeSha : null;
  if (!(await closePullRequest(ctx.db, taskId, raw.state, mergeSha))) return { ok: false, message: "already updated" };
  assertTier("sync-pull-request-status", "automatic");
  const issue = await ctx.issues.get(taskId, companyId);
  if (raw.state === "merged") {
    await setDecisionOutcome(ctx.db, taskId, "accepted", null);
    if (issue) {
      await ctx.issues.update(taskId, { status: "done" }, companyId);
      await ctx.issues.createComment(taskId, `Pull request #${pr.number} was merged on GitHub after review: ${pr.url}`, companyId);
    }
  } else {
    await setDecisionOutcome(ctx.db, taskId, "rejected", "pull request closed on GitHub without merging");
    if (issue) {
      await ctx.issues.update(taskId, { status: "cancelled" }, companyId);
      await ctx.issues.createComment(taskId, `Pull request #${pr.number} was closed on GitHub without merging: ${pr.url}`, companyId);
    }
  }
  return { ok: true, message: raw.state };
}
