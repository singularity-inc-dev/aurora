/** Settings come from the environment (or a local .env that git ignores). Never logged. */
export interface ServiceConfig {
  paperclipUrl: string;
  /** Board API key for authenticated Paperclip; not needed in local trusted mode. */
  paperclipApiKey: string | null;
  companyId: string;
  plugin: string;
  smtp: { host: string; port: number; secure: boolean; user: string | null; pass: string | null };
  mailFrom: string;
  listenHost: string;
  listenPort: number;
  pollSeconds: number;
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
  return {
    paperclipUrl: (env.PAPERCLIP_URL ?? "http://127.0.0.1:3100").replace(/\/+$/, ""),
    paperclipApiKey: env.PAPERCLIP_API_KEY?.trim() || null,
    companyId: need("VT_COMPANY_ID"),
    plugin: env.VT_PLUGIN?.trim() || "vision-and-tom.night-agents",
    smtp: {
      host: env.SMTP_HOST?.trim() || "127.0.0.1",
      port: int("SMTP_PORT", 1025),
      secure: env.SMTP_SECURE === "true",
      user: env.SMTP_USER?.trim() || null,
      pass: env.SMTP_PASS || null,
    },
    mailFrom: env.MAIL_FROM?.trim() || "Vision and Tom <briefing@localhost>",
    listenHost: env.LISTEN_HOST?.trim() || "127.0.0.1",
    listenPort: int("LISTEN_PORT", 3299),
    pollSeconds: int("POLL_SECONDS", 60),
  };
}
