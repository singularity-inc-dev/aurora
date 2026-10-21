import nodemailer from "nodemailer";
import type { ServiceConfig } from "./config.ts";
import type { Email, PluginApi } from "./paperclip.ts";

export type SendMail = (email: Email) => Promise<void>;

export function smtpSender(cfg: ServiceConfig): SendMail {
  const transport = nodemailer.createTransport({
    host: cfg.smtp.host,
    port: cfg.smtp.port,
    secure: cfg.smtp.secure,
    ...(cfg.smtp.user && cfg.smtp.pass ? { auth: { user: cfg.smtp.user, pass: cfg.smtp.pass } } : {}),
  });
  return async (email) => {
    await transport.sendMail({ from: cfg.mailFrom, to: email.to, subject: email.subject, text: email.text, html: email.html });
  };
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
      log(`could not send briefing ${email.briefingId}: ${err instanceof Error ? err.message.split("\n")[0] : "unknown error"}`);
    }
  }
  return sent;
}
