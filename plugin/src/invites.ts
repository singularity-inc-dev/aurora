import { randomUUID } from "node:crypto";
import type { PluginContext, PluginDatabaseClient } from "@paperclipai/plugin-sdk";
import { findPersonByEmail, isValidTimezone, MAX_PEOPLE, type InviteSettings, type PluginSettings } from "./config.js";
import { assertTier } from "./tiers.js";
import { signInvite, verifyInvite } from "./tokens.js";

type Db = Pick<PluginDatabaseClient, "namespace" | "execute" | "query">;
const table = (db: Db) => `"${db.namespace}".invites`;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** A try that never reported back (the email service stopped mid-join) gives the invite back after this long. */
export const JOIN_LEASE_MINUTES = 10;
/** After this many failed tries the invite is used up and the admin sends a new one. */
export const MAX_JOIN_ATTEMPTS = 5;

/** What vt-invite made for the new person's agent (piece A: agent isolation). */
export interface InviteAgent {
  agentEnvironmentId: string;
  agentUser: string;
  checksKey: { type: "secret_ref"; secretId: string };
}

export interface InviteRow {
  id: string;
  companyId: string;
  email: string;
  timezone: string;
  expiresAt: Date;
  state: "new" | "processing" | "done" | "failed";
  result: string | null;
  agent: InviteAgent | null;
  /** Tries so far; each try takes the invite with a compare-and-swap on this number. */
  attempts: number;
  usedAt: Date | null;
  /** What earlier tries already made (reported back by the email service), so a new try reuses them. */
  userId: string | null;
  agentId: string | null;
}

const USER_RE = /^[a-z_][a-z0-9_-]{0,31}$/;
const ID_RE = /^[A-Za-z0-9-]{1,64}$/;

/** The agent part of an invite request, or null when it is missing or malformed. */
export function parseInviteAgent(raw: unknown): InviteAgent | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const key = (r.checksKey ?? {}) as Record<string, unknown>;
  if (typeof r.agentEnvironmentId !== "string" || !ID_RE.test(r.agentEnvironmentId)) return null;
  if (typeof r.agentUser !== "string" || !USER_RE.test(r.agentUser)) return null;
  if (key.type !== "secret_ref" || typeof key.secretId !== "string" || !ID_RE.test(key.secretId)) return null;
  return { agentEnvironmentId: r.agentEnvironmentId, agentUser: r.agentUser, checksKey: { type: "secret_ref", secretId: key.secretId } };
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
    agent:
      r.agent_environment_id && r.agent_user && r.checks_key_secret_id
        ? { agentEnvironmentId: String(r.agent_environment_id), agentUser: String(r.agent_user), checksKey: { type: "secret_ref", secretId: String(r.checks_key_secret_id) } }
        : null,
    attempts: Number(r.attempts ?? 0),
    usedAt: r.used_at ? new Date(r.used_at instanceof Date ? r.used_at.getTime() : String(r.used_at)) : null,
    userId: (r.user_id as string | null) ?? null,
    agentId: (r.agent_id as string | null) ?? null,
  };
}

/** A try that started longer ago than the lease and never reported back. */
function abandoned(row: InviteRow, now: Date): boolean {
  return row.state === "processing" && (!row.usedAt || now.getTime() - row.usedAt.getTime() >= JOIN_LEASE_MINUTES * 60_000);
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
  input: { email?: unknown; timezone?: unknown; agent?: unknown },
  now: Date,
): Promise<InviteCreated> {
  if (!settings.links) return { ok: false, message: "set up the handback email links first (they sign invites too)" };
  const email = typeof input.email === "string" ? input.email.trim().toLowerCase() : "";
  if (!EMAIL_RE.test(email)) return { ok: false, message: "a valid email is required" };
  if (findPersonByEmail(settings, email)) return { ok: false, message: "this person is already on the team" };
  if (settings.people.length >= MAX_PEOPLE) return { ok: false, message: `the team already has ${MAX_PEOPLE} people` };
  const timezone = typeof input.timezone === "string" && input.timezone.trim() ? input.timezone.trim() : settings.invites.defaultTimezone;
  if (!isValidTimezone(timezone)) return { ok: false, message: "timezone must be an IANA timezone, e.g. Europe/London" };
  const agent = parseInviteAgent(input.agent);
  if (input.agent !== undefined && !agent) return { ok: false, message: "the agent's user and environment are malformed" };
  // Fail closed: with isolation required, every new agent gets its own system user first (vt-invite does that as root).
  if (settings.isolation.required && !agent) return { ok: false, message: "the new agent needs its own system user first (run vt-invite on the server, as root)" };
  if (agent && settings.people.some((p) => p.agentEnvironmentId === agent.agentEnvironmentId || p.agentUser === agent.agentUser)) {
    return { ok: false, message: "that agent user already belongs to someone on the team" };
  }

  const id = randomUUID();
  const expiresAt = new Date(now.getTime() + settings.invites.expiresMinutes * 60_000);
  await ctx.db.execute(
    `INSERT INTO ${table(ctx.db)} (id, company_id, email, timezone, expires_at, agent_environment_id, agent_user, checks_key_secret_id) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [id, companyId, email, timezone, expiresAt.toISOString(), agent?.agentEnvironmentId ?? null, agent?.agentUser ?? null, agent?.checksKey.secretId ?? null],
  );
  const secret = await ctx.secrets.resolve(settings.links.signingSecret, { companyId });
  const token = signInvite({ v: 1, k: "join", i: id, c: companyId, o: email, e: Math.floor(expiresAt.getTime() / 1000) }, secret);
  return { ok: true, inviteId: id, email, url: `${settings.links.baseUrl}/join/${token}`, expiresAt: expiresAt.toISOString() };
}

export type InviteCheck =
  | { ok: true; status: "valid"; message: string; email: string; timezone: string; inviteId: string; agent: InviteAgent | null }
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
  if (row.state === "processing" && !abandoned(row, now)) {
    return { ok: false, status: "already-used", message: `This invite link is being used right now. If your join stopped halfway, try again in ${JOIN_LEASE_MINUTES} minutes.` };
  }
  if (row.state === "done") return { ok: false, status: "already-used", message: "This invite link was already used." };
  if (row.state === "failed") return { ok: false, status: "already-used", message: "This invite link can no longer be used. Ask for a new one." };
  return { ok: true, status: "valid", message: "ok", email: row.email, timezone: row.timezone, inviteId: row.id, agent: row.agent, row };
}

export async function previewInvite(ctx: PluginContext, settings: PluginSettings, companyId: string, token: string, now: Date) {
  const { row: _row, ...check } = await authenticate(ctx, settings, companyId, token, now);
  // The page only needs to know who is invited.
  if (check.ok) {
    const { agent: _agent, ...shown } = check;
    return shown;
  }
  return check;
}

export interface NewPersonPlan {
  inviteId: string;
  /** This try's number; the email service reports back with it. */
  attempt: number;
  email: string;
  timezone: string;
  defaults: InviteSettings;
  /** The new agent's own system user and environment (null only with isolation off). */
  agent: InviteAgent | null;
  /** What an earlier, failed try already made: reuse it instead of making it again. */
  resume: { userId: string | null; agentId: string | null };
}

export type InviteClaim = { ok: true; status: "claimed"; plan: NewPersonPlan } | { ok: false; status: "invalid" | "expired" | "already-used" | "refused"; message: string };

/** The person in the settings is the one an earlier try of this invite saved. */
function joinedBy(row: InviteRow, person: { agentId: string; agentEnvironmentId?: string | null; agentUser?: string | null }): boolean {
  if (row.agent) return person.agentEnvironmentId === row.agent.agentEnvironmentId && person.agentUser === row.agent.agentUser;
  return row.agentId !== null && person.agentId === row.agentId;
}

/**
 * Take the invite for one try (only one try runs at a time). The caller then
 * creates the account, the agent and the settings row, and reports back with
 * finishInvite. A try that fails gives the invite back (finishInvite); one
 * that never reports back is taken over after JOIN_LEASE_MINUTES.
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
  const row = auth.row!;
  assertTier("join-from-invite", "needs-tap");
  const existing = findPersonByEmail(settings, auth.email);
  if (existing) {
    // An earlier try saved the settings row and stopped before reporting back: the join is complete.
    if (row.attempts > 0 && joinedBy(row, existing)) {
      await ctx.db.execute(`UPDATE ${table(ctx.db)} SET state = 'done', result = 'joined', agent_id = $1 WHERE id = $2 AND state = $3 AND attempts = $4`, [
        existing.agentId,
        row.id,
        row.state,
        row.attempts,
      ]);
      return { ok: false, status: "already-used", message: "You have already joined. Sign in with your email and the password you chose." };
    }
    return { ok: false, status: "refused", message: "This person is already on the team." };
  }
  if (settings.people.length >= MAX_PEOPLE) return { ok: false, status: "refused", message: `The team already has ${MAX_PEOPLE} people.` };
  const tz = typeof timezone === "string" && timezone.trim() ? timezone.trim() : auth.timezone;
  if (!isValidTimezone(tz)) return { ok: false, status: "refused", message: "Please pick a valid timezone, e.g. Europe/London." };
  const attempt = row.attempts + 1;
  const { rowCount } = await ctx.db.execute(
    `UPDATE ${table(ctx.db)} SET state = 'processing', used_at = now(), timezone = $1, attempts = $2 WHERE id = $3 AND state = $4 AND attempts = $5`,
    [tz, attempt, row.id, row.state, row.attempts],
  );
  if (rowCount !== 1) return { ok: false, status: "already-used", message: "This invite link is being used right now." };
  if (settings.isolation.required && !auth.agent) {
    await setResult(ctx.db, auth.inviteId, "failed", "no agent user for this invite");
    return { ok: false, status: "refused", message: "This invite has no agent user. Ask for a new one." };
  }
  return {
    ok: true,
    status: "claimed",
    plan: { inviteId: auth.inviteId, attempt, email: auth.email, timezone: tz, defaults: settings.invites, agent: auth.agent, resume: { userId: row.userId, agentId: row.agentId } },
  };
}

const PAPERCLIP_ID_RE = /^[A-Za-z0-9_-]{1,100}$/;
const idOrNull = (v: unknown): string | null => (typeof v === "string" && PAPERCLIP_ID_RE.test(v) ? v : null);

/**
 * Record how a try went. Success is only recorded when the plugin settings
 * really contain the new person bound to the new agent. A failed try gives the
 * invite back (with what it already made, so the next try reuses it), until
 * MAX_JOIN_ATTEMPTS tries have failed.
 */
export async function finishInvite(
  ctx: PluginContext,
  settings: PluginSettings,
  companyId: string,
  inviteId: string,
  result: { ok?: unknown; agentId?: unknown; userId?: unknown; message?: unknown; attempt?: unknown },
): Promise<{ ok: boolean; message: string; retry?: boolean }> {
  const row = await getInvite(ctx.db, inviteId);
  if (!row || row.companyId !== companyId || row.state !== "processing") return { ok: false, message: "invite is not being processed" };
  // Only the try that holds the invite may report (not one that was taken over).
  const attempt = typeof result.attempt === "number" ? result.attempt : row.attempts;
  if (attempt !== row.attempts) return { ok: false, message: "this try was taken over by a newer one" };
  if (result.ok === true && typeof result.agentId === "string") {
    const person = findPersonByEmail(settings, row.email);
    const boundToItsUser = !row.agent || (person?.agentEnvironmentId === row.agent.agentEnvironmentId && person?.agentUser === row.agent.agentUser);
    if (!person || person.agentId !== result.agentId || !boundToItsUser) {
      return { ...(await giveBack(ctx.db, row, "the settings row for this person was not saved", idOrNull(result.userId), idOrNull(result.agentId))), ok: false, message: "the settings row for this person was not saved" };
    }
    await ctx.db.execute(`UPDATE ${table(ctx.db)} SET state = 'done', result = $1, agent_id = $2, user_id = $3 WHERE id = $4 AND state = 'processing'`, [
      "joined",
      result.agentId,
      idOrNull(result.userId),
      row.id,
    ]);
    return { ok: true, message: "joined" };
  }
  const message = typeof result.message === "string" ? result.message.slice(0, 200) : "join failed";
  return giveBack(ctx.db, row, message, idOrNull(result.userId), idOrNull(result.agentId));
}

/** A failed try: the invite can be used again (keeping what was made), or is used up after too many tries. */
async function giveBack(db: Db, row: InviteRow, message: string, userId: string | null, agentId: string | null): Promise<{ ok: true; message: string; retry: boolean }> {
  if (row.attempts >= MAX_JOIN_ATTEMPTS) {
    await setResult(db, row.id, "failed", `${message} (after ${row.attempts} tries)`);
    return { ok: true, message: "recorded", retry: false };
  }
  await db.execute(`UPDATE ${table(db)} SET state = 'new', result = $1, user_id = $2, agent_id = $3 WHERE id = $4 AND state = 'processing' AND attempts = $5`, [
    message,
    userId ?? row.userId,
    agentId ?? row.agentId,
    row.id,
    row.attempts,
  ]);
  return { ok: true, message: "recorded", retry: true };
}

async function setResult(db: Db, id: string, state: "failed", result: string): Promise<void> {
  await db.execute(`UPDATE ${table(db)} SET state = $1, result = $2 WHERE id = $3`, [state, result, id]);
}
