import type { PluginContext } from "@paperclipai/plugin-sdk";
import {
  claimAction,
  claimDecision,
  DECIDABLE,
  finishAction,
  getAction,
  releaseDecision,
  setDecisionOutcome,
  type LinkAction,
} from "./briefstore.js";
import { findPersonByEmail, type PluginSettings } from "./config.js";
import { getTaskRow } from "./eventlog.js";
import { mergeApproved } from "./merge.js";
import { assertTier, TierRefused } from "./tiers.js";
import { verifyLink, type LinkClaims } from "./tokens.js";

export const MAX_REASON_LENGTH = 200;

export type LinkOutcome =
  | { ok: true; status: "merged" | "rejected"; message: string }
  | { ok: false; status: "invalid" | "expired" | "already-used" | "refused" | "needs-reason"; message: string };

export interface LinkCheck {
  ok: boolean;
  status: "valid" | "invalid" | "expired" | "already-used";
  message: string;
  kind?: "approve" | "reject";
  task?: { identifier: string | null; title: string };
}

const INVALID = { ok: false as const, status: "invalid" as const, message: "This link is not valid." };

/** Every check that does not change anything: signature, expiry, database match, owner binding. */
async function authenticate(
  ctx: PluginContext,
  settings: PluginSettings,
  companyId: string,
  token: string,
  now: Date,
): Promise<{ ok: true; claims: LinkClaims; action: LinkAction } | { ok: false; status: "invalid" | "expired"; message: string }> {
  if (!settings.links) return INVALID;
  const secret = await ctx.secrets.resolve(settings.links.signingSecret, { companyId });
  const v = verifyLink(token, secret, now);
  if (!v.ok) return v.reason === "expired" ? { ok: false, status: "expired", message: "This link has expired." } : INVALID;
  const c = v.claims;
  if (c.c !== companyId) return INVALID;
  const action = await getAction(ctx.db, c.a);
  // The signed claims must match the stored link exactly: a link for one
  // person's task can never act on another task or for another person.
  if (!action || action.companyId !== c.c || action.owner !== c.o || action.taskId !== c.t || action.kind !== c.k) return INVALID;
  if (action.expiresAt.getTime() <= now.getTime()) return { ok: false, status: "expired", message: "This link has expired." };
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
  return { ok: true, status: "valid", message: "ok", kind: auth.claims.k, task };
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
