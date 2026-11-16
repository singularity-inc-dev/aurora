/**
 * Agent isolation on the server (thin version 1, piece A). The root-only tools
 * (deploy/lib/agents.sh, run by vt-setup and vt-invite) make a system user for
 * each person and two fresh SSH keys for it. This module hands those keys to
 * Paperclip: an SSH environment that logs in as that user (Paperclip keeps the
 * key as its own secret) and the key for running checks as that user. Running it
 * again for the same person replaces the keys instead of adding new ones.
 */
import { readFileSync } from "node:fs";

export interface AgentLogin {
  /** System user, e.g. vt-a-0123456789. */
  user: string;
  host: string;
  port: number;
  /** known_hosts line for host:port. */
  knownHosts: string;
  /** Root-only files written by agents.sh; read here, deleted by the caller. */
  runKeyFile: string;
  checksKeyFile: string;
}

export interface AgentBinding {
  agentEnvironmentId: string;
  agentUser: string;
  checksKey: { type: "secret_ref"; secretId: string };
}

export type Call = <T = unknown>(method: string, path: string, body?: unknown) => Promise<T>;

const USER_RE = /^[a-z_][a-z0-9_-]{0,31}$/;
export const environmentName = (user: string) => `Agent user ${user}`;
export const checksKeyName = (user: string) => `vt-checks-key-${user}`;

/** Read the agent login handed over by agents.sh (JSON in an environment variable). */
export function parseAgentLogin(raw: string | undefined): AgentLogin | null {
  if (!raw) return null;
  const v = JSON.parse(raw) as Partial<AgentLogin>;
  if (typeof v.user !== "string" || !USER_RE.test(v.user)) throw new Error("agent login: bad user name");
  if (typeof v.host !== "string" || !v.host || typeof v.port !== "number") throw new Error("agent login: bad host");
  if (typeof v.knownHosts !== "string" || !v.knownHosts) throw new Error("agent login: no host key");
  if (typeof v.runKeyFile !== "string" || typeof v.checksKeyFile !== "string") throw new Error("agent login: no keys");
  return v as AgentLogin;
}

const list = <T>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : ((v as { items?: T[] } | null)?.items ?? []));

export async function ensureAgentEnvironment(call: Call, companyId: string, login: AgentLogin): Promise<AgentBinding> {
  const c = encodeURIComponent(companyId);
  const config = {
    host: login.host,
    port: login.port,
    username: login.user,
    remoteWorkspacePath: `/home/${login.user}/work`,
    privateKey: readFileSync(login.runKeyFile, "utf8"),
    knownHosts: login.knownHosts,
    strictHostKeyChecking: true,
  };
  const name = environmentName(login.user);
  const existing = list<{ id: string; name: string }>(await call("GET", `/api/companies/${c}/environments`)).find((e) => e.name === name);
  const env = existing
    ? await call<{ id: string }>("PATCH", `/api/environments/${encodeURIComponent(existing.id)}`, { config })
    : await call<{ id: string }>("POST", `/api/companies/${c}/environments`, { name, driver: "ssh", config });

  const checksValue = readFileSync(login.checksKeyFile, "utf8");
  const key = checksKeyName(login.user);
  const secret = list<{ id: string; key: string }>(await call("GET", `/api/companies/${c}/secrets`)).find((s) => s.key === key);
  let secretId: string;
  if (secret) {
    await call("POST", `/api/secrets/${encodeURIComponent(secret.id)}/rotate`, { value: checksValue });
    secretId = secret.id;
  } else {
    secretId = (await call<{ id: string }>("POST", `/api/companies/${c}/secrets`, { name: key, key, value: checksValue })).id;
  }
  return { agentEnvironmentId: env.id, agentUser: login.user, checksKey: { type: "secret_ref", secretId } };
}

/** Adapter settings every agent needs in an SSH environment (Paperclip runs Claude over SSH only with its CLI engine). */
export function isolatedAdapterConfig(adapterType: string, base: Record<string, unknown>): Record<string, unknown> {
  return adapterType === "claude_local" ? { ...base, engine: "cli" } : { ...base };
}
