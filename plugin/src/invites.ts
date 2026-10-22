import { randomUUID } from "node:crypto";
import type { PluginContext, PluginDatabaseClient } from "@paperclipai/plugin-sdk";
import { findPersonByEmail, isValidTimezone, MAX_PEOPLE, type InviteSettings, type PluginSettings } from "./config.js";
import { assertTier } from "./tiers.js";
import { signInvite, verifyInvite } from "./tokens.js";

type Db = Pick<PluginDatabaseClient, "namespace" | "execute" | "query">;
const table = (db: Db) => `"${db.namespace}".invites`;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export interface InviteRow {
  id: string;
  companyId: string;
  email: string;
  timezone: string;
  expiresAt: Date;
  state: "new" | "processing" | "done" | "failed";
  result: string | null;
}

function toInvite(r: Record<string, unknown>): InviteRow {
  return {
    id: String(r.id),
    companyId: String(r.company_id),
    email: String(r.email),
    timezone: String(r.timezone),
    expiresAt: new Date(String(r.expires_at)),
    state: String(r.state) as InviteRow["state"],
    result: (r.result as string | null) ?? null,
  };
}

async function getInvite(db: Db, id: string): Promise<InviteRow | null> {
  const rows = await db.query(`SELECT * FROM ${table(db)} WHERE id = $1`, [id]);
  return rows[0] ? toInvite(rows[0]) : null;
}

export type InviteCreated = { ok: true; inviteId: string; email: string; url: string; expiresAt: string } | { ok: false; message: string };

/** Make one signed invite link for one new person. The token is not stored. */
export async function createInvite(
  ctx: PluginContext,
  settings: PluginSettings,
  companyId: string,
  input: { email?: unknown; timezone?: unknown },
  now: Date,
): Promise<InviteCreated> {
  if (!settings.links) return { ok: false, message: "set up the morning email links first (they sign invites too)" };
  const email = typeof input.email === "string" ? input.email.trim().toLowerCase() : "";
  if (!EMAIL_RE.test(email)) return { ok: false, message: "a valid email is required" };
  if (findPersonByEmail(settings, email)) return { ok: false, message: "this person is already on the team" };
  if (settings.people.length >= MAX_PEOPLE) return { ok: false, message: `the team already has ${MAX_PEOPLE} people` };
  const timezone = typeof input.timezone === "string" && input.timezone.trim() ? input.timezone.trim() : settings.invites.defaultTimezone;
  if (!isValidTimezone(timezone)) return { ok: false, message: "timezone must be an IANA timezone, e.g. Europe/London" };

  const id = randomUUID();
  const expiresAt = new Date(now.getTime() + settings.invites.expiresMinutes * 60_000);
  await ctx.db.execute(`INSERT INTO ${table(ctx.db)} (id, company_id, email, timezone, expires_at) VALUES ($1, $2, $3, $4, $5)`, [
    id,
    companyId,
    email,
    timezone,
    expiresAt.toISOString(),
  ]);
  const secret = await ctx.secrets.resolve(settings.links.signingSecret, { companyId });
  const token = signInvite({ v: 1, k: "join", i: id, c: companyId, o: email, e: Math.floor(expiresAt.getTime() / 1000) }, secret);
  return { ok: true, inviteId: id, email, url: `${settings.links.baseUrl}/join/${token}`, expiresAt: expiresAt.toISOString() };
}

export type InviteCheck =
  | { ok: true; status: "valid"; message: string; email: string; timezone: string; inviteId: string }
  | { ok: false; status: "invalid" | "expired" | "already-used"; message: string };

const INVALID = { ok: false as const, status: "invalid" as const, message: "This invite link is not valid." };
const EXPIRED = { ok: false as const, status: "expired" as const, message: "This invite link has expired. Ask for a new one." };

/** Signature, expiry, database match. Changes nothing. */
async function authenticate(ctx: PluginContext, settings: PluginSettings, companyId: string, token: string, now: Date): Promise<InviteCheck & { row?: InviteRow }> {
  if (!settings.links) return INVALID;
  const secret = await ctx.secrets.resolve(settings.links.signingSecret, { companyId });
  const v = verifyInvite(token, secret, now);
  if (!v.ok) return v.reason === "expired" ? EXPIRED : INVALID;
  const c = v.claims;
  if (c.c !== companyId) return INVALID;
  const row = await getInvite(ctx.db, c.i);
  if (!row || row.companyId !== c.c || row.email !== c.o) return INVALID;
  if (row.expiresAt.getTime() <= now.getTime()) return EXPIRED;
  if (row.state !== "new") return { ok: false, status: "already-used", message: "This invite link was already used." };
  return { ok: true, status: "valid", message: "ok", email: row.email, timezone: row.timezone, inviteId: row.id, row };
}

export async function previewInvite(ctx: PluginContext, settings: PluginSettings, companyId: string, token: string, now: Date): Promise<InviteCheck> {
  const { row: _row, ...check } = await authenticate(ctx, settings, companyId, token, now);
  return check;
}

export interface NewPersonPlan {
  inviteId: string;
  email: string;
  timezone: string;
  defaults: InviteSettings;
}

export type InviteClaim = { ok: true; status: "claimed"; plan: NewPersonPlan } | { ok: false; status: "invalid" | "expired" | "already-used" | "refused"; message: string };

/**
 * Use up the invite (only the first request gets past this). The caller then
 * creates the account, the agent and the settings row, and reports back with
 * finishInvite.
 */
export async function claimInvite(
  ctx: PluginContext,
  settings: PluginSettings,
  companyId: string,
  token: string,
  timezone: unknown,
  now: Date,
): Promise<InviteClaim> {
  const auth = await authenticate(ctx, settings, companyId, token, now);
  if (!auth.ok) return auth;
  assertTier("join-from-invite", "needs-tap");
  if (findPersonByEmail(settings, auth.email)) return { ok: false, status: "refused", message: "This person is already on the team." };
  if (settings.people.length >= MAX_PEOPLE) return { ok: false, status: "refused", message: `The team already has ${MAX_PEOPLE} people.` };
  const tz = typeof timezone === "string" && timezone.trim() ? timezone.trim() : auth.timezone;
  if (!isValidTimezone(tz)) return { ok: false, status: "refused", message: "Please pick a valid timezone, e.g. Europe/London." };
  const { rowCount } = await ctx.db.execute(`UPDATE ${table(ctx.db)} SET state = 'processing', used_at = now(), timezone = $1 WHERE id = $2 AND state = 'new'`, [
    tz,
    auth.inviteId,
  ]);
  if (rowCount !== 1) return { ok: false, status: "already-used", message: "This invite link was already used." };
  return { ok: true, status: "claimed", plan: { inviteId: auth.inviteId, email: auth.email, timezone: tz, defaults: settings.invites } };
}

/**
 * Record how the join went. Success is only recorded when the plugin settings
 * really contain the new person bound to the new agent.
 */
export async function finishInvite(
  ctx: PluginContext,
  settings: PluginSettings,
  companyId: string,
  inviteId: string,
  result: { ok?: unknown; agentId?: unknown; userId?: unknown; message?: unknown },
): Promise<{ ok: boolean; message: string }> {
  const row = await getInvite(ctx.db, inviteId);
  if (!row || row.companyId !== companyId || row.state !== "processing") return { ok: false, message: "invite is not being processed" };
  if (result.ok === true && typeof result.agentId === "string") {
    const person = findPersonByEmail(settings, row.email);
    if (!person || person.agentId !== result.agentId) {
      await setResult(ctx.db, row.id, "failed", "the settings row for this person was not saved");
      return { ok: false, message: "the settings row for this person was not saved" };
    }
    await ctx.db.execute(`UPDATE ${table(ctx.db)} SET state = 'done', result = $1, agent_id = $2, user_id = $3 WHERE id = $4 AND state = 'processing'`, [
      "joined",
      result.agentId,
      typeof result.userId === "string" ? result.userId : null,
      row.id,
    ]);
    return { ok: true, message: "joined" };
  }
  const message = typeof result.message === "string" ? result.message.slice(0, 200) : "join failed";
  await setResult(ctx.db, row.id, "failed", message);
  return { ok: true, message: "recorded" };
}

async function setResult(db: Db, id: string, state: "failed", result: string): Promise<void> {
  await db.execute(`UPDATE ${table(db)} SET state = $1, result = $2 WHERE id = $3`, [state, result, id]);
}
