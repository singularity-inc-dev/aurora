import { readFileSync } from "node:fs";
import nodemailer from "nodemailer";
import type { ServiceConfig } from "./config.ts";
import type { Email, PluginApi } from "./paperclip.ts";

export type SendMail = (email: Pick<Email, "to" | "subject" | "text" | "html">) => Promise<void>;

/** Any SMTP account: host, port, user, password (from a secret file), TLS or STARTTLS. */
export function smtpSender(cfg: ServiceConfig): SendMail {
  const transport = nodemailer.createTransport({
    host: cfg.smtp.host,
    port: cfg.smtp.port,
    secure: cfg.smtp.secure,
    requireTLS: cfg.smtp.requireTls,
    ...(cfg.smtp.user && cfg.smtp.pass ? { auth: { user: cfg.smtp.user, pass: cfg.smtp.pass } } : {}),
    ...(cfg.smtp.caFile ? { tls: { ca: readFileSync(cfg.smtp.caFile) } } : {}),
  });
  return async (email) => {
    await transport.sendMail({ from: cfg.mailFrom, to: email.to, subject: email.subject, text: email.text, html: email.html });
  };
}

/** First line of an error, without anything that looks like a secret we hold. */
export function safeError(err: unknown, secrets: Array<string | null> = []): string {
  let msg = err instanceof Error ? (err.message.split("\n")[0] ?? "error") : "unknown error";
  for (const s of secrets) if (s) msg = msg.split(s).join("[hidden]");
  return msg;
}

/**
 * Send every pending briefing, then mark it sent. A crash between the two can
 * send one email twice; its links still act only once.
 */
export async function sendPending(api: PluginApi, sendMail: SendMail, log: (msg: string) => void = () => {}): Promise<number> {
  let sent = 0;
  for (const email of await api.pendingEmails()) {
    try {
      await sendMail(email);
      await api.markSent(email.briefingId);
      sent += 1;
    } catch (err) {
      log(`could not send briefing ${email.briefingId}: ${safeError(err)}`);
    }
  }
  return sent;
}
