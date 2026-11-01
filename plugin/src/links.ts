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
  listProcessingActions,
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
  /** The approval being published (the email service keeps track of the ones in flight). */
  actionId: string;
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
  /** The task's owner: only they may use the link (the email service checks their sign-in). */
  owner?: string;
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
  return {
    ok: true,
    status: "valid",
    message: "ok",
    kind: auth.claims.k,
    task,
    owner: auth.claims.o,
    ...(settings.github && auth.claims.k === "approve" ? { github: settings.github.repo } : {}),
  };
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
  signedInAs: unknown,
): Promise<LinkOutcome> {
  const auth = await authenticate(ctx, settings, companyId, token, now);
  if (!auth.ok) return auth;
  const { claims, action } = auth;
  // Only the task's owner decides it. The email service says who is signed in to
  // Paperclip in the browser that pressed the button; anyone else is refused
  // before the link is used up, so the owner can still use it.
  if (typeof signedInAs !== "string" || signedInAs.trim().toLowerCase() !== claims.o) {
    return { ok: false, status: "refused", message: `Only ${claims.o} can ${claims.k} this task. Sign in to Paperclip as ${claims.o}, then open the link again.` };
  }
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
    return { ok: true, status: "publish", message: "publish to GitHub", publish: publishRequestFor(settings.github.repo, action, name, issue?.title ?? null) };
  }
  return mergeLocally(ctx, companyId, action, name, issue?.title ?? null, Boolean(issue));
}

/** What the email service must publish for an approved task (GitHub mode). */
function publishRequestFor(repo: string, action: LinkAction, name: string, title: string | null): PublishRequest {
  return {
    actionId: action.id,
    repo,
    worktree: action.workspaceCwd ?? "",
    branch: action.branch ?? "",
    baseBranch: baseBranchName(action.baseRef ?? ""),
    expectedHead: action.expectedHead ?? "",
    title: `${name}: ${title ?? "handover task"}`,
    body: `Approved by ${action.owner} from the Vision and Tom morning email.\n\nTask ${name}, branch ${action.branch} at ${action.expectedHead}.`,
  };
}

/** Approve without GitHub: merge into the local base branch (safe to repeat: an already merged head counts as merged). */
async function mergeLocally(ctx: PluginContext, companyId: string, action: LinkAction, name: string, title: string | null, hasIssue: boolean): Promise<LinkOutcome> {
  if (!action.workspaceCwd || !action.branch || !action.baseRef || !action.expectedHead) {
    await releaseDecision(ctx.db, action.taskId, action.id);
    await finishAction(ctx.db, action.id, "refused", "nothing to merge");
    return { ok: false, status: "refused", message: "There is nothing to merge for this task." };
  }
  const merge = await mergeApproved({
    cwd: action.workspaceCwd,
    branch: action.branch,
    baseRef: action.baseRef,
    expectedHead: action.expectedHead,
    message: `Merge ${name}: ${title ?? ""} (approved by ${action.owner} via Vision and Tom)`,
  });
  if (!merge.ok) {
    await releaseDecision(ctx.db, action.taskId, action.id);
    await finishAction(ctx.db, action.id, "refused", merge.message);
    return { ok: false, status: "refused", message: `Not merged: ${merge.message}.` };
  }
  await setDecisionOutcome(ctx.db, action.taskId, "accepted", null);
  if (hasIssue) {
    await ctx.issues.update(action.taskId, { status: "done" }, companyId);
    await ctx.issues.createComment(
      action.taskId,
      `Approved by ${action.owner} from the morning email. Merged ${action.branch} at ${action.expectedHead.slice(0, 7)} into ${action.baseRef} (${merge.mergeSha.slice(0, 7)}).`,
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
  return applyPublishResult(ctx, companyId, action, raw);
}

/** Record what GitHub did for an approval that is in progress (its task's decision belongs to it). */
async function applyPublishResult(ctx: PluginContext, companyId: string, action: LinkAction, raw: Record<string, unknown>): Promise<LinkOutcome> {
  const owner = action.owner;
  const taskId = action.taskId;
  const issue = await ctx.issues.get(taskId, companyId);
  const name = issue?.identifier ?? taskId;
  const number = Number(raw.number);
  const url = typeof raw.url === "string" && /^https?:\/\//.test(raw.url) ? raw.url : null;
  const hasPr = Number.isInteger(number) && number > 0 && url !== null;

  if (raw.result === "merged" && hasPr) {
    const mergeSha = typeof raw.mergeSha === "string" && SHA_RE.test(raw.mergeSha) ? raw.mergeSha : null;
    await insertWaitingPullRequest(ctx.db, { taskId, companyId, owner, actionId: action.id, number, url, headSha: action.expectedHead ?? "", reason: null });
    await closePullRequest(ctx.db, taskId, "merged", mergeSha);
    await setDecisionOutcome(ctx.db, taskId, "accepted", null);
    if (issue) {
      await ctx.issues.update(taskId, { status: "done" }, companyId);
      await ctx.issues.createComment(taskId, `Approved by ${owner} from the morning email. Pull request #${number} was squash-merged on GitHub: ${url}`, companyId);
    }
    await finishAction(ctx.db, action.id, "done", `merged on GitHub: pull request #${number}`);
    return { ok: true, status: "merged", message: `${name} was merged on GitHub (pull request #${number}).` };
  }
  if (raw.result === "waiting" && hasPr) {
    const reason = typeof raw.reason === "string" && raw.reason.trim() ? raw.reason.replace(/\s+/g, " ").trim().slice(0, 200) : "branch protection requires a review";
    await insertWaitingPullRequest(ctx.db, { taskId, companyId, owner, actionId: action.id, number, url, headSha: action.expectedHead ?? "", reason });
    if (issue) {
      await ctx.issues.update(taskId, { status: "in_review" }, companyId);
      await ctx.issues.createComment(taskId, `Approved by ${owner}. Pull request #${number} is waiting for review on GitHub (${reason}): ${url}`, companyId);
    }
    await finishAction(ctx.db, action.id, "done", `waiting for review: pull request #${number}`);
    return { ok: true, status: "waiting", message: `${name}: pull request #${number} is waiting for review on GitHub (${reason}). ${url}` };
  }
  const message = typeof raw.message === "string" && raw.message.trim() ? raw.message.replace(/\s+/g, " ").trim().slice(0, 200) : "GitHub did not accept the change";
  await releaseDecision(ctx.db, taskId, action.id);
  await finishAction(ctx.db, action.id, "refused", message);
  return { ok: false, status: "refused", message: `Not merged: ${message}.` };
}

/** A click normally takes seconds; one still in progress after this long was interrupted (a crash or restart). */
export const STUCK_AFTER_MINUTES = 15;
/** The email service may ask for a shorter wait (test beds), never shorter than this. */
export const MIN_STUCK_MINUTES = 1;

function stuckMinutes(raw: unknown): number {
  const n = Number(raw);
  return Number.isFinite(n) && n >= MIN_STUCK_MINUTES ? Math.min(n, 24 * 60) : STUCK_AFTER_MINUTES;
}

const isStuck = (action: LinkAction, minutes: number, now: Date) => action.state === "processing" && (!action.usedAt || now.getTime() - action.usedAt.getTime() >= minutes * 60_000);

/** An interrupted approval whose task's decision it still holds, with nothing decided yet. */
async function heldUndecided(ctx: PluginContext, action: LinkAction): Promise<boolean> {
  const ev = await getTaskRow(ctx.db, action.taskId);
  return ev?.decision_action_id === action.id && (ev.outcome === null || ev.outcome === undefined);
}

export interface StuckApproval {
  actionId: string;
  taskId: string;
  publish: PublishRequest;
}

/**
 * GitHub mode: approvals that were interrupted between the tap and the email
 * service reporting back. Only the email service can see GitHub, so it finishes
 * them (recoverApproval); the owner's tap and the version check still apply.
 */
export async function listStuckApprovals(ctx: PluginContext, settings: PluginSettings, companyId: string, rawMinutes: unknown, now: Date): Promise<StuckApproval[]> {
  if (!settings.github) return [];
  const minutes = stuckMinutes(rawMinutes);
  const out: StuckApproval[] = [];
  for (const action of await listProcessingActions(ctx.db, companyId)) {
    if (action.kind !== "approve" || !isStuck(action, minutes, now) || !(await heldUndecided(ctx, action))) continue;
    if (!action.workspaceCwd || !action.branch || !action.baseRef || !action.expectedHead) continue;
    const issue = await ctx.issues.get(action.taskId, companyId);
    out.push({ actionId: action.id, taskId: action.taskId, publish: publishRequestFor(settings.github.repo, action, issue?.identifier ?? action.taskId, issue?.title ?? null) });
  }
  return out;
}

/** The email service finished (or gave up on) an interrupted approval it found with listStuckApprovals. */
export async function recoverApproval(ctx: PluginContext, settings: PluginSettings, companyId: string, raw: Record<string, unknown>, now: Date): Promise<LinkOutcome> {
  const action = typeof raw.actionId === "string" ? await getAction(ctx.db, raw.actionId) : null;
  if (!settings.github || !action || action.companyId !== companyId || action.kind !== "approve" || !isStuck(action, stuckMinutes(raw.olderThanMinutes), now) || !(await heldUndecided(ctx, action))) {
    return { ok: false, status: "refused", message: "This approval is not waiting to be recovered." };
  }
  return applyPublishResult(ctx, companyId, action, raw);
}

/**
 * Run by the handover tick: finish or release clicks that were interrupted.
 * - The task was already decided: only the link's record is finished.
 * - The click never took the task's decision: the link is closed, the task is unchanged.
 * - A Reject (its reason was lost) or a GitHub approval the email service could not finish
 *   within a day: the task is released and comes back in the next email with fresh links.
 * - An approval without GitHub: the merge is finished (the version check still applies).
 * GitHub approvals are otherwise left to the email service (listStuckApprovals).
 */
export async function recoverInterruptedActions(ctx: PluginContext, settings: PluginSettings, companyId: string, now: Date): Promise<number> {
  let recovered = 0;
  for (const action of await listProcessingActions(ctx.db, companyId)) {
    if (!isStuck(action, STUCK_AFTER_MINUTES, now)) continue;
    const ev = await getTaskRow(ctx.db, action.taskId);
    const outcome = (ev?.outcome as string | null | undefined) ?? null;
    if (ev?.decision_action_id !== action.id) {
      await finishAction(ctx.db, action.id, "refused", "interrupted before it changed anything");
    } else if (outcome === "accepted" || outcome === "rejected") {
      await finishAction(ctx.db, action.id, "done", `${outcome} (recorded after an interruption)`);
    } else if (action.kind === "approve" && !settings.github) {
      const issue = await ctx.issues.get(action.taskId, companyId);
      await mergeLocally(ctx, companyId, action, issue?.identifier ?? action.taskId, issue?.title ?? null, Boolean(issue));
    } else if (action.kind === "reject" || isStuck(action, 24 * 60, now)) {
      await releaseDecision(ctx.db, action.taskId, action.id);
      await finishAction(ctx.db, action.id, "refused", "interrupted; the task comes back in the next email");
    } else continue;
    recovered += 1;
  }
  return recovered;
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
