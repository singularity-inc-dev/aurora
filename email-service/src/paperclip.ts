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
}

export interface LinkOutcome {
  ok: boolean;
  status: "merged" | "rejected" | "invalid" | "expired" | "already-used" | "refused" | "needs-reason";
  message: string;
}

/** What the service needs from the plugin. Kept as an interface so tests can fake it. */
export interface PluginApi {
  pendingEmails(): Promise<Email[]>;
  markSent(briefingId: string): Promise<void>;
  preview(token: string): Promise<LinkCheck>;
  execute(token: string, reason: string | null): Promise<LinkOutcome>;
}

/** Calls the plugin's board-only routes under /api/plugins/:plugin/api/. */
export function paperclipApi(cfg: ServiceConfig, fetchImpl: typeof fetch = fetch): PluginApi {
  const base = `${cfg.paperclipUrl}/api/plugins/${encodeURIComponent(cfg.plugin)}/api`;
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (cfg.paperclipApiKey) headers.authorization = `Bearer ${cfg.paperclipApiKey}`;

  async function call<T>(method: "GET" | "POST", path: string, body?: Record<string, unknown>): Promise<T> {
    const res = await fetchImpl(`${base}${path}`, {
      method,
      headers,
      ...(body ? { body: JSON.stringify({ companyId: cfg.companyId, ...body }) } : {}),
    });
    if (!res.ok) throw new Error(`Paperclip answered ${res.status} for ${path.split("?")[0]}`);
    return (await res.json()) as T;
  }

  return {
    async pendingEmails() {
      return (await call<{ emails: Email[] }>("GET", `/briefings/pending?companyId=${encodeURIComponent(cfg.companyId)}`)).emails;
    },
    async markSent(briefingId) {
      await call("POST", `/briefings/${encodeURIComponent(briefingId)}/sent`, {});
    },
    preview: (token) => call<LinkCheck>("POST", "/links/preview", { token }),
    execute: (token, reason) => call<LinkOutcome>("POST", "/links/execute", { token, ...(reason !== null ? { reason } : {}) }),
  };
}
