import { readFileSync } from "node:fs";

/** Settings come from the environment (or a local .env that git ignores). Never logged. */
export interface ServiceConfig {
  paperclipUrl: string;
  /** Public address of Paperclip (sent as Origin when signing new people up). */
  paperclipPublicUrl: string;
  /** Board API key for authenticated Paperclip; not needed in local trusted mode. */
  paperclipApiKey: string | null;
  companyId: string;
  plugin: string;
  smtp: {
    host: string;
    port: number;
    /** TLS from the first byte (port 465). */
    secure: boolean;
    /** Refuse to send unless the server upgrades with STARTTLS (port 587). */
    requireTls: boolean;
    user: string | null;
    pass: string | null;
    /** Extra CA certificate to trust (only for test servers with their own certificate). */
    caFile: string | null;
  };
  mailFrom: string;
  listenHost: string;
  listenPort: number;
  pollSeconds: number;
  /** Folder for the email service's own files (the git mirror used to publish). */
  stateDir: string;
  github: {
    /** Only the Approve path reads it. Kept out of Paperclip entirely. */
    token: string | null;
    apiUrl: string;
    gitUrl: string;
    syncMinutes: number;
  };
}

/** A secret comes from NAME_FILE (preferred: e.g. a systemd credential) or NAME. */
function secret(env: NodeJS.ProcessEnv, key: string, fileOnly = false): string | null {
  if (fileOnly && env[key]) throw new Error(`${key} may only be given as a file (${key}_FILE)`);
  const file = env[`${key}_FILE`]?.trim();
  if (file) {
    let value: string;
    try {
      value = readFileSync(file, "utf8").trim();
    } catch {
      throw new Error(`cannot read the file named by ${key}_FILE`);
    }
    return value || null;
  }
  return env[key]?.trim() || null;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServiceConfig {
  const need = (key: string): string => {
    const v = env[key]?.trim();
    if (!v) throw new Error(`missing setting ${key}`);
    return v;
  };
  const int = (key: string, fallback: number): number => {
    const v = env[key];
    if (v === undefined || v === "") return fallback;
    const n = Number(v);
    if (!Number.isInteger(n) || n <= 0) throw new Error(`setting ${key} must be a positive whole number`);
    return n;
  };
  const url = (key: string, fallback: string): string => {
    const v = env[key]?.trim() || fallback;
    try {
      return new URL(v).toString().replace(/\/+$/, "");
    } catch {
      throw new Error(`setting ${key} must be an http(s) address`);
    }
  };
  const paperclipUrl = url("PAPERCLIP_URL", "http://127.0.0.1:3100");
  const port = int("SMTP_PORT", 1025);
  return {
    paperclipUrl,
    paperclipPublicUrl: url("PAPERCLIP_PUBLIC_URL", paperclipUrl),
    paperclipApiKey: secret(env, "PAPERCLIP_API_KEY"),
    companyId: need("VT_COMPANY_ID"),
    plugin: env.VT_PLUGIN?.trim() || "vision-and-tom.night-agents",
    smtp: {
      host: env.SMTP_HOST?.trim() || "127.0.0.1",
      port,
      secure: env.SMTP_SECURE ? env.SMTP_SECURE === "true" : port === 465,
      requireTls: env.SMTP_REQUIRE_TLS === "true",
      user: env.SMTP_USER?.trim() || null,
      pass: secret(env, "SMTP_PASS"),
      caFile: env.SMTP_CA_FILE?.trim() || null,
    },
    mailFrom: env.MAIL_FROM?.trim() || "Vision and Tom <briefing@localhost>",
    listenHost: env.LISTEN_HOST?.trim() || "127.0.0.1",
    listenPort: int("LISTEN_PORT", 3299),
    pollSeconds: int("POLL_SECONDS", 60),
    stateDir: env.STATE_DIR?.trim() || ".state",
    github: {
      token: secret(env, "GITHUB_TOKEN", true),
      apiUrl: url("GITHUB_API_URL", "https://api.github.com"),
      gitUrl: url("GITHUB_GIT_URL", "https://github.com"),
      syncMinutes: int("GITHUB_SYNC_MINUTES", 10),
    },
  };
}
