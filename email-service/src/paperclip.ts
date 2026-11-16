import type { AgentBinding } from "./agentenv.ts";
import type { ServiceConfig } from "./config.ts";
import { parseRawCounts, type RawCounts } from "./counts.ts";

export interface Email {
  briefingId: string;
  to: string;
  subject: string;
  text: string;
  html: string;
}

export interface LinkCheck {
  ok: boolean;
  status: "valid" | "invalid" | "expired" | "already-used";
  message: string;
  kind?: "approve" | "reject";
  task?: { identifier: string | null; title: string };
  github?: string;
  /** The task's owner: only they may press Approve or Reject (checked against their Paperclip sign-in). */
  owner?: string;
}

/** What the plugin asks the email service to publish on GitHub for an approved task. */
export interface PublishRequest {
  /** The approval being published (kept in flight so the recovery never races it). */
  actionId?: string;
  repo: string;
  worktree: string;
  branch: string;
  baseBranch: string;
  expectedHead: string;
  title: string;
  body: string;
}

export type LinkOutcome =
  | { ok: boolean; status: "merged" | "rejected" | "waiting" | "invalid" | "expired" | "already-used" | "refused" | "needs-reason"; message: string }
  | { ok: true; status: "publish"; message: string; publish: PublishRequest };

export type PublishResult =
  | { result: "merged"; number: number; url: string; mergeSha: string }
  | { result: "waiting"; number: number; url: string; reason: string }
  | { result: "failed"; message: string };

/** An approval interrupted between the tap and GitHub (a crash), found by the plugin. */
export interface StuckApproval {
  actionId: string;
  taskId: string;
  publish: PublishRequest;
}

/** What the plugin's replay-save route answers (plugin/src/replaysave.ts). Contract-tested live by scripts/it/v1g.sh. */
export interface ReplaySaveResult {
  added: number;
  skipped: Array<{ taskId: string; reason: string }>;
  tasks: Array<Record<string, unknown>>;
  checks: Record<string, unknown>;
}

export interface WaitingPullRequest {
  taskId: string;
  number: number;
  url: string;
  headSha: string;
}

export interface InviteCheck {
  ok: boolean;
  status: "valid" | "invalid" | "expired" | "already-used";
  message: string;
  email?: string;
  timezone?: string;
}

export interface InviteDefaults {
  handoverStartHour: number;
  handoverBudgetCapCents: number;
  maxTasksPerHandover: number;
  agentAdapterType: string;
  agentAdapterConfig: Record<string, unknown>;
  agentMonthlyBudgetCents: number;
}

export type InviteClaim =
  | {
      ok: true;
      status: "claimed";
      plan: {
        inviteId: string;
        /** This try's number (an invite can be tried again after a failure). */
        attempt?: number;
        email: string;
        timezone: string;
        defaults: InviteDefaults;
        agent: AgentBinding | null;
        /** What an earlier, failed try already made. */
        resume?: { userId: string | null; agentId: string | null };
      };
    }
  | { ok: false; status: "invalid" | "expired" | "already-used" | "refused"; message: string };

/** One ticket the owner can hand over (in their agent's backlog), with a draft note if there is one. */
export interface HandoverTicket {
  id: string;
  identifier: string | null;
  title: string;
  description: string;
  /** A note started earlier: "agent" = suggested by the owner's agent (Help me plan). */
  draft: { source: "owner" | "agent"; what: string; doneWhen: string; files: string } | null;
}

export interface HandoverStatus {
  ok: boolean;
  message?: string;
  email?: string;
  timezone?: string;
  handoverStartHour?: number;
  maxTasks?: number;
  helpMePlan?: boolean;
  limits?: { defaultMinutes: number; maxMinutes: number; defaultBudgetCents: number; maxBudgetCents: number };
  tickets?: HandoverTicket[];
  /** Handed over for the next scheduled handover, not started yet. */
  queued?: Array<{ taskId: string; title: string; doneWhen: string }>;
  handovers?: Array<{ handoverKey: string; kind: "scheduled" | "now"; status: string; stopReason: string | null }>;
}

/** One task of the owner's handover: their note. */
export interface HandoverTask {
  issueId: string;
  what: string;
  doneWhen: string;
  files: string;
  maxMinutes?: string;
  budgetCents?: string;
}

export interface HandoverAnswer {
  ok: boolean;
  message?: string;
  /** Teammates' files a ticket reached into (nothing was handed over). */
  overlaps?: string[];
  /** Warnings worth the owner's attention (e.g. GitHub teams in CODEOWNERS). */
  notes?: string[];
  handoverKey?: string | null;
}

/** What the service needs from the plugin. Kept as an interface so tests can fake it. */
export interface PluginApi {
  pendingEmails(): Promise<Email[]>;
  markSent(briefingId: string): Promise<void>;
  preview(token: string): Promise<LinkCheck>;
  /** `signedInAs`: who is signed in to Paperclip in the browser that pressed the button (the plugin refuses anyone but the owner). */
  execute(token: string, reason: string | null, signedInAs: string): Promise<LinkOutcome>;
  publishResult(token: string, result: PublishResult): Promise<LinkOutcome>;
  waitingPullRequests(): Promise<{ repo: string | null; pullRequests: WaitingPullRequest[] }>;
  pullRequestUpdate(taskId: string, state: "merged" | "closed", mergeSha: string | null): Promise<void>;
  createInvite(email: string, timezone: string | null, agent?: AgentBinding | null): Promise<{ ok: boolean; message?: string; url?: string; email?: string; expiresAt?: string }>;
  previewInvite(token: string): Promise<InviteCheck>;
  claimInvite(token: string, timezone: string | null): Promise<InviteClaim>;
  /** The owner's Hand over page (only ever called for the owner signed in to Paperclip). */
  handoverStatus(email: string): Promise<HandoverStatus>;
  /** The owner's tap: exactly these tasks with these notes, now or at their scheduled time. */
  startHandover(email: string, when: "now" | "scheduled", tasks: HandoverTask[]): Promise<HandoverAnswer>;
  /** Take back what waits for the scheduled handover. */
  withdrawHandover(email: string): Promise<HandoverAnswer>;
  /** Help me plan (only if it is on for the owner): ask the agent for draft suggestions. */
  askSuggestions(email: string): Promise<HandoverAnswer>;
  /** The pilot's numbers from the event log (piece F): a summary, and the measurement sheet as CSV. */
  numbers(): Promise<Record<string, unknown>>;
  numbersCsv(): Promise<string>;
  /** Raw counts per person and per task kind (milestone 6), and the event log as CSV. */
  counts(): Promise<RawCounts>;
  eventsCsv(): Promise<string>;
  /** Save decided tasks for the replay tool and return them (see docs/REPLAY.md). */
  replaySave(limit: number, includeUndecided: boolean): Promise<ReplaySaveResult>;
  finishInvite(
    inviteId: string,
    result: { ok: true; agentId: string; userId: string; attempt?: number } | { ok: false; message: string; attempt?: number; userId?: string | null; agentId?: string | null },
  ): Promise<{ ok: boolean; message: string; retry?: boolean }>;
  /** Approvals interrupted for longer than `olderThanMinutes` (GitHub mode). */
  stuckApprovals(olderThanMinutes: number): Promise<StuckApproval[]>;
  recoverApproval(actionId: string, olderThanMinutes: number, result: PublishResult): Promise<LinkOutcome>;
}

export class PaperclipError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function headersFor(cfg: ServiceConfig): Record<string, string> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (cfg.paperclipApiKey) headers.authorization = `Bearer ${cfg.paperclipApiKey}`;
  return headers;
}

/** Longest any one HTTP call (to Paperclip or GitHub) may take, answer body included. */
export const HTTP_TIMEOUT_MS = 30_000;

export interface FetchLimits {
  timeoutMs?: number;
  /** Tries in all for a call that is safe to repeat (default 3). */
  attempts?: number;
  /** Pause before the second try; doubles each time (default 500 ms). */
  baseDelayMs?: number;
}

/** Options for one call: `repeatable` marks a POST that is safe to send twice. GET and HEAD always are. */
export type LimitedInit = RequestInit & { repeatable?: boolean };

const LIMITED = Symbol("limitedFetch");

/**
 * fetch with a time limit on every call, so one slow answer never hangs a step.
 * A call that is safe to repeat is retried with backoff after a network error, a
 * time-out or a 5xx answer; never after a 4xx, and never a one-time action.
 */
export function limitedFetch(fetchImpl: typeof fetch = fetch, limits: FetchLimits = {}): typeof fetch {
  if ((fetchImpl as { [LIMITED]?: boolean })[LIMITED]) return fetchImpl;
  const timeoutMs = limits.timeoutMs ?? HTTP_TIMEOUT_MS;
  const attempts = Math.max(1, limits.attempts ?? 3);
  const base = limits.baseDelayMs ?? 500;
  const limited = (async (input: string | URL | Request, init: LimitedInit = {}) => {
    const { repeatable, ...rest } = init;
    const method = (rest.method ?? "GET").toUpperCase();
    const tries = repeatable || method === "GET" || method === "HEAD" ? attempts : 1;
    let last: unknown;
    for (let attempt = 1; attempt <= tries; attempt += 1) {
      if (attempt > 1) await new Promise((r) => setTimeout(r, base * 2 ** (attempt - 2)));
      const limit = AbortSignal.timeout(timeoutMs);
      try {
        const res = await fetchImpl(input, { ...rest, signal: rest.signal ? AbortSignal.any([rest.signal, limit]) : limit });
        if (res.status < 500 || attempt === tries) return res;
        last = new PaperclipError(res.status, `answered ${res.status}`);
      } catch (err) {
        last = err;
      }
    }
    throw last;
  }) as typeof fetch;
  (limited as unknown as { [LIMITED]: boolean })[LIMITED] = true;
  return limited;
}

/** Calls the plugin's board-only routes under /api/plugins/:plugin/api/. */
export function paperclipApi(cfg: ServiceConfig, rawFetch: typeof fetch = fetch): PluginApi {
  const fetchImpl = limitedFetch(rawFetch);
  const base = `${cfg.paperclipUrl}/api/plugins/${encodeURIComponent(cfg.plugin)}/api`;
  const headers = headersFor(cfg);
  const company = `companyId=${encodeURIComponent(cfg.companyId)}`;

  async function call<T>(method: "GET" | "POST", path: string, body?: Record<string, unknown>, okStatuses: number[] = [], repeatable = false): Promise<T> {
    const init: LimitedInit = {
      method,
      headers,
      repeatable,
      ...(body ? { body: JSON.stringify({ companyId: cfg.companyId, ...body }) } : {}),
    };
    const res = await fetchImpl(`${base}${path}`, init);
    if (!res.ok && !okStatuses.includes(res.status)) throw new PaperclipError(res.status, `Paperclip answered ${res.status} for ${path.split("?")[0]}`);
    return (await res.json()) as T;
  }

  return {
    async pendingEmails() {
      return (await call<{ emails: Email[] }>("GET", `/briefings/pending?${company}`)).emails;
    },
    async markSent(briefingId) {
      // Safe to repeat: it only moves a briefing from pending to sent.
      await call("POST", `/briefings/${encodeURIComponent(briefingId)}/sent`, {}, [], true);
    },
    preview: (token) => call<LinkCheck>("POST", "/links/preview", { token }),
    execute: (token, reason, signedInAs) => call<LinkOutcome>("POST", "/links/execute", { token, signedInAs, ...(reason !== null ? { reason } : {}) }),
    publishResult: (token, result) => call<LinkOutcome>("POST", "/links/publish-result", { token, ...result }),
    waitingPullRequests: () => call("GET", `/prs/waiting?${company}`),
    async pullRequestUpdate(taskId, state, mergeSha) {
      await call("POST", "/prs/update", { taskId, state, mergeSha });
    },
    createInvite: (email, timezone, agent) => call("POST", "/invites", { email, ...(timezone ? { timezone } : {}), ...(agent ? { agent } : {}) }, [409]),
    previewInvite: (token) => call<InviteCheck>("POST", "/invites/preview", { token }),
    claimInvite: (token, timezone) => call<InviteClaim>("POST", "/invites/claim", { token, ...(timezone ? { timezone } : {}) }),
    finishInvite: (inviteId, result) => call("POST", "/invites/finish", { inviteId, ...result }),
    async stuckApprovals(olderThanMinutes) {
      return (await call<{ approvals: StuckApproval[] }>("GET", `/links/stuck?${company}&olderThanMinutes=${olderThanMinutes}`)).approvals;
    },
    recoverApproval: (actionId, olderThanMinutes, result) => call<LinkOutcome>("POST", "/links/recover", { actionId, olderThanMinutes, ...result }),
    handoverStatus: (email) => call<HandoverStatus>("GET", `/handovers/status?${company}&email=${encodeURIComponent(email)}`, undefined, [404]),
    startHandover: (email, when, tasks) => call("POST", "/handovers/start", { email, when, tasks }, [400, 404, 409]),
    withdrawHandover: (email) => call("POST", "/handovers/withdraw", { email }, [404]),
    askSuggestions: (email) => call("POST", "/handovers/suggest", { email }, [404, 409]),
    numbers: () => call("GET", `/numbers?${company}`),
    async numbersCsv() {
      return (await call<{ csv: string }>("GET", `/numbers/csv?${company}`)).csv;
    },
    async counts() {
      return parseRawCounts(await call("GET", `/counts?${company}`));
    },
    async eventsCsv() {
      return (await call<{ csv: string }>("GET", `/events/csv?${company}`)).csv;
    },
    replaySave: (limit, includeUndecided) => call<ReplaySaveResult>("POST", "/replay/save", { limit, includeUndecided }),
  };
}

/** Board calls the join flow needs (the board API key acts for the owner). */
export interface BoardApi {
  createHumanInvite(): Promise<string>;
  createAgent(input: { name: string; adapterType: string; adapterConfig: Record<string, unknown>; budgetMonthlyCents: number; defaultEnvironmentId?: string | null }): Promise<string>;
  /** Any board call (used for the agent's environment, agentenv.ts). */
  request<T = unknown>(method: string, path: string, body?: unknown): Promise<T>;
  getAgent(agentId: string): Promise<Record<string, unknown>>;
  /** The agent whose default environment is this one (each new person's environment is their own), or null. */
  findAgentByEnvironment(environmentId: string): Promise<string | null>;
  /** Agents never create agents or skills (also re-applied to an agent an earlier join try made). */
  lockAgent(agentId: string): Promise<void>;
  /** Is this user already a member of the company? */
  isMember(userId: string): Promise<boolean>;
  /** Plugin settings for the company (read, change, save). */
  getPluginConfig(): Promise<Record<string, unknown>>;
  savePluginConfig(config: Record<string, unknown>): Promise<void>;
}

/** Calls a new person makes for themselves (sign-up, accepting the Paperclip invite). */
export interface PersonApi {
  /** Creates the account and returns its session cookie and user id. */
  signUp(input: { email: string; password: string; name: string }): Promise<{ cookie: string; userId: string }>;
  /** Signs in to an account an earlier join try made (needs the same password). */
  signIn(input: { email: string; password: string }): Promise<{ cookie: string; userId: string }>;
  acceptInvite(cookie: string, paperclipInviteToken: string): Promise<void>;
}

export function boardApi(cfg: ServiceConfig, rawFetch: typeof fetch = fetch): BoardApi {
  const fetchImpl = limitedFetch(rawFetch);
  const headers = headersFor(cfg);
  let pluginId: string | null = null;
  async function req<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetchImpl(`${cfg.paperclipUrl}${path}`, { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    if (!res.ok) throw new PaperclipError(res.status, `Paperclip answered ${res.status} for ${method} ${path.replace(/[0-9a-f-]{36}/g, ":id").split("?")[0]}`);
    return (await res.json()) as T;
  }
  async function resolvePluginId(): Promise<string> {
    if (pluginId) return pluginId;
    const list = await req<Array<{ id: string; pluginKey?: string; key?: string }>>("GET", "/api/plugins");
    const found = list.find((p) => (p.pluginKey ?? p.key) === cfg.plugin);
    if (!found) throw new PaperclipError(404, "the Aurora plugin is not installed");
    pluginId = found.id;
    return pluginId;
  }
  const c = encodeURIComponent(cfg.companyId);
  async function lockAgent(agentId: string): Promise<void> {
    // Set again through the permissions route, which is what the plugin's route audit reads.
    await req("PATCH", `/api/agents/${encodeURIComponent(agentId)}/permissions`, { canCreateAgents: false, canCreateSkills: false, canAssignTasks: true });
  }
  return {
    async createHumanInvite() {
      const inv = await req<{ token: string }>("POST", `/api/companies/${c}/invites`, { allowedJoinTypes: "human", humanRole: "operator" });
      return inv.token;
    },
    async createAgent(input) {
      const agent = await req<{ id: string }>("POST", `/api/companies/${c}/agents`, {
        name: input.name,
        role: "engineer",
        adapterType: input.adapterType,
        adapterConfig: input.adapterConfig,
        budgetMonthlyCents: input.budgetMonthlyCents,
        permissions: { canCreateAgents: false, canCreateSkills: false },
        ...(input.defaultEnvironmentId ? { defaultEnvironmentId: input.defaultEnvironmentId } : {}),
      });
      await lockAgent(agent.id);
      return agent.id;
    },
    lockAgent,
    getAgent: (agentId) => req("GET", `/api/agents/${encodeURIComponent(agentId)}`),
    async findAgentByEnvironment(environmentId) {
      const list = await req<Array<{ id?: unknown; defaultEnvironmentId?: unknown; status?: unknown }>>("GET", `/api/companies/${c}/agents`);
      const found = Array.isArray(list) ? list.find((a) => a.defaultEnvironmentId === environmentId && a.status !== "terminated") : undefined;
      return typeof found?.id === "string" ? found.id : null;
    },
    async isMember(userId) {
      const res = await req<{ members?: Array<{ principalId?: unknown }> }>("GET", `/api/companies/${c}/members`);
      return Array.isArray(res.members) && res.members.some((m) => m.principalId === userId);
    },
    request: (method, path, body) => req(method, path, body),
    async getPluginConfig() {
      const id = await resolvePluginId();
      const res = await req<{ configJson?: Record<string, unknown> } | null>("GET", `/api/plugins/${id}/config?companyId=${c}`);
      return res?.configJson ?? {};
    },
    async savePluginConfig(config) {
      const id = await resolvePluginId();
      await req("POST", `/api/plugins/${id}/config`, { companyId: cfg.companyId, configJson: config });
    },
  };
}

/** Who is signed in to Paperclip in this browser (its session cookie), or null. */
export interface SessionApi {
  whoIs(cookie: string): Promise<{ email: string } | null>;
}

export function sessionApi(cfg: ServiceConfig, rawFetch: typeof fetch = fetch): SessionApi {
  const fetchImpl = limitedFetch(rawFetch);
  const origin = new URL(cfg.paperclipPublicUrl).origin;
  return {
    async whoIs(cookie) {
      if (!cookie) return null;
      // The browser's own Paperclip sign-in, checked by Paperclip itself; the cookie is never stored.
      const res = await fetchImpl(`${cfg.paperclipUrl}/api/auth/get-session`, { headers: { cookie, origin } });
      if (!res.ok) return null;
      const body = (await res.json().catch(() => null)) as { user?: { email?: unknown } } | null;
      return typeof body?.user?.email === "string" ? { email: body.user.email.toLowerCase() } : null;
    },
  };
}

/** The session a sign-up or sign-in started: its cookie and the user's id. */
async function sessionOf(res: Response): Promise<{ cookie: string; userId: string }> {
  const cookie = res.headers
    .getSetCookie()
    .map((c) => c.split(";")[0]!)
    .join("; ");
  const body = (await res.json()) as { user?: { id?: string } };
  if (!cookie || !body.user?.id) throw new PaperclipError(502, "Paperclip did not start a session for the new account");
  return { cookie, userId: body.user.id };
}

export function personApi(cfg: ServiceConfig, rawFetch: typeof fetch = fetch): PersonApi {
  const fetchImpl = limitedFetch(rawFetch);
  // Paperclip's auth checks that requests come from its own public address.
  const origin = new URL(cfg.paperclipPublicUrl).origin;
  return {
    async signUp(input) {
      const res = await fetchImpl(`${cfg.paperclipUrl}/api/auth/sign-up/email`, {
        method: "POST",
        headers: { "content-type": "application/json", origin },
        body: JSON.stringify(input),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { code?: string; message?: string };
        if (res.status === 422 || /exist/i.test(body.code ?? body.message ?? "")) throw new PaperclipError(409, "an account with this email already exists");
        throw new PaperclipError(res.status, `Paperclip refused the new account (${res.status})`);
      }
      return sessionOf(res);
    },
    async signIn(input) {
      const res = await fetchImpl(`${cfg.paperclipUrl}/api/auth/sign-in/email`, {
        method: "POST",
        headers: { "content-type": "application/json", origin },
        body: JSON.stringify({ email: input.email, password: input.password }),
      });
      if (res.status === 401) throw new PaperclipError(401, "the password does not match the existing account");
      if (!res.ok) throw new PaperclipError(res.status, `Paperclip refused the sign-in (${res.status})`);
      return sessionOf(res);
    },
    async acceptInvite(cookie, token) {
      const res = await fetchImpl(`${cfg.paperclipUrl}/api/invites/${encodeURIComponent(token)}/accept`, {
        method: "POST",
        headers: { "content-type": "application/json", origin, cookie },
        body: JSON.stringify({ requestType: "human" }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: unknown };
        // Paperclip answers 409 "You already belong to this company" to a member.
        if (res.status === 409 && /already belong/i.test(String(body.error ?? ""))) throw new PaperclipError(409, "already a member of the company");
        throw new PaperclipError(res.status, `Paperclip refused to add the new person to the company (${res.status})`);
      }
    },
  };
}
