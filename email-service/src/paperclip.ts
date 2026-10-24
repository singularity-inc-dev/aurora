import type { ServiceConfig } from "./config.ts";

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
}

/** What the plugin asks the email service to publish on GitHub for an approved task. */
export interface PublishRequest {
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
  nightStartHour: number;
  nightBudgetCapCents: number;
  maxTasksPerNight: number;
  agentAdapterType: string;
  agentAdapterConfig: Record<string, unknown>;
  agentMonthlyBudgetCents: number;
}

export type InviteClaim =
  | { ok: true; status: "claimed"; plan: { inviteId: string; email: string; timezone: string; defaults: InviteDefaults } }
  | { ok: false; status: "invalid" | "expired" | "already-used" | "refused"; message: string };

/** What the service needs from the plugin. Kept as an interface so tests can fake it. */
export interface PluginApi {
  pendingEmails(): Promise<Email[]>;
  markSent(briefingId: string): Promise<void>;
  preview(token: string): Promise<LinkCheck>;
  execute(token: string, reason: string | null): Promise<LinkOutcome>;
  publishResult(token: string, result: PublishResult): Promise<LinkOutcome>;
  waitingPullRequests(): Promise<{ repo: string | null; pullRequests: WaitingPullRequest[] }>;
  pullRequestUpdate(taskId: string, state: "merged" | "closed", mergeSha: string | null): Promise<void>;
  createInvite(email: string, timezone: string | null): Promise<{ ok: boolean; message?: string; url?: string; email?: string; expiresAt?: string }>;
  previewInvite(token: string): Promise<InviteCheck>;
  claimInvite(token: string, timezone: string | null): Promise<InviteClaim>;
  finishInvite(inviteId: string, result: { ok: true; agentId: string; userId: string } | { ok: false; message: string }): Promise<{ ok: boolean; message: string }>;
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

/** Calls the plugin's board-only routes under /api/plugins/:plugin/api/. */
export function paperclipApi(cfg: ServiceConfig, fetchImpl: typeof fetch = fetch): PluginApi {
  const base = `${cfg.paperclipUrl}/api/plugins/${encodeURIComponent(cfg.plugin)}/api`;
  const headers = headersFor(cfg);
  const company = `companyId=${encodeURIComponent(cfg.companyId)}`;

  async function call<T>(method: "GET" | "POST", path: string, body?: Record<string, unknown>, okStatuses: number[] = []): Promise<T> {
    const res = await fetchImpl(`${base}${path}`, {
      method,
      headers,
      ...(body ? { body: JSON.stringify({ companyId: cfg.companyId, ...body }) } : {}),
    });
    if (!res.ok && !okStatuses.includes(res.status)) throw new PaperclipError(res.status, `Paperclip answered ${res.status} for ${path.split("?")[0]}`);
    return (await res.json()) as T;
  }

  return {
    async pendingEmails() {
      return (await call<{ emails: Email[] }>("GET", `/briefings/pending?${company}`)).emails;
    },
    async markSent(briefingId) {
      await call("POST", `/briefings/${encodeURIComponent(briefingId)}/sent`, {});
    },
    preview: (token) => call<LinkCheck>("POST", "/links/preview", { token }),
    execute: (token, reason) => call<LinkOutcome>("POST", "/links/execute", { token, ...(reason !== null ? { reason } : {}) }),
    publishResult: (token, result) => call<LinkOutcome>("POST", "/links/publish-result", { token, ...result }),
    waitingPullRequests: () => call("GET", `/prs/waiting?${company}`),
    async pullRequestUpdate(taskId, state, mergeSha) {
      await call("POST", "/prs/update", { taskId, state, mergeSha });
    },
    createInvite: (email, timezone) => call("POST", "/invites", { email, ...(timezone ? { timezone } : {}) }, [409]),
    previewInvite: (token) => call<InviteCheck>("POST", "/invites/preview", { token }),
    claimInvite: (token, timezone) => call<InviteClaim>("POST", "/invites/claim", { token, ...(timezone ? { timezone } : {}) }),
    finishInvite: (inviteId, result) => call("POST", "/invites/finish", { inviteId, ...result }),
  };
}

/** Board calls the join flow needs (the board API key acts for the owner). */
export interface BoardApi {
  createHumanInvite(): Promise<string>;
  createAgent(input: { name: string; adapterType: string; adapterConfig: Record<string, unknown>; budgetMonthlyCents: number }): Promise<string>;
  getAgent(agentId: string): Promise<Record<string, unknown>>;
  /** Plugin settings for the company (read, change, save). */
  getPluginConfig(): Promise<Record<string, unknown>>;
  savePluginConfig(config: Record<string, unknown>): Promise<void>;
}

/** Calls a new person makes for themselves (sign-up, accepting the Paperclip invite). */
export interface PersonApi {
  /** Creates the account and returns its session cookie and user id. */
  signUp(input: { email: string; password: string; name: string }): Promise<{ cookie: string; userId: string }>;
  acceptInvite(cookie: string, paperclipInviteToken: string): Promise<void>;
}

export function boardApi(cfg: ServiceConfig, fetchImpl: typeof fetch = fetch): BoardApi {
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
    if (!found) throw new PaperclipError(404, "the Vision and Tom plugin is not installed");
    pluginId = found.id;
    return pluginId;
  }
  const c = encodeURIComponent(cfg.companyId);
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
      });
      // Set again through the permissions route, which is what the plugin's route audit reads.
      await req("PATCH", `/api/agents/${encodeURIComponent(agent.id)}/permissions`, { canCreateAgents: false, canCreateSkills: false, canAssignTasks: true });
      return agent.id;
    },
    getAgent: (agentId) => req("GET", `/api/agents/${encodeURIComponent(agentId)}`),
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

export function personApi(cfg: ServiceConfig, fetchImpl: typeof fetch = fetch): PersonApi {
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
      const cookie = res.headers
        .getSetCookie()
        .map((c) => c.split(";")[0]!)
        .join("; ");
      const body = (await res.json()) as { user?: { id?: string } };
      if (!cookie || !body.user?.id) throw new PaperclipError(502, "Paperclip did not start a session for the new account");
      return { cookie, userId: body.user.id };
    },
    async acceptInvite(cookie, token) {
      const res = await fetchImpl(`${cfg.paperclipUrl}/api/invites/${encodeURIComponent(token)}/accept`, {
        method: "POST",
        headers: { "content-type": "application/json", origin, cookie },
        body: JSON.stringify({ requestType: "human" }),
      });
      if (!res.ok) throw new PaperclipError(res.status, `Paperclip refused to add the new person to the company (${res.status})`);
    },
  };
}
