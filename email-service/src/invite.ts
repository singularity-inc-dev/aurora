/**
 * Make an invite link for one new person and email it to them.
 * Usage: node src/invite.ts <email> [timezone]
 * Prints the link too, so the owner can send it another way.
 */
import { loadConfig } from "./config.ts";
import { safeError, smtpSender } from "./mailer.ts";
import { esc } from "./pages.ts";
import { paperclipApi } from "./paperclip.ts";

const [email, timezone] = process.argv.slice(2);
if (!email) {
  console.error("Usage: vt-invite <email> [timezone, e.g. Europe/London]");
  process.exit(2);
}
const cfg = loadConfig();
const created = await paperclipApi(cfg).createInvite(email, timezone ?? null);
if (!created.ok || !created.url) {
  console.error(`Not created: ${created.message ?? "unknown reason"}`);
  process.exit(1);
}
console.log(`Invite for ${created.email}, valid until ${created.expiresAt} (works once):`);
console.log(created.url);
if (process.env.VT_INVITE_NO_EMAIL === "1") process.exit(0);
const text = `Hello,\n\nYou are invited to join your team's Vision and Tom workspace. Open this link to create your account and your personal night agent (it works once and expires ${created.expiresAt?.replace("T", " ").slice(0, 16)} UTC):\n\n${created.url}\n`;
try {
  await smtpSender(cfg)({
    to: created.email!,
    subject: "Your invite to Vision and Tom",
    text,
    html: `<p>Hello,</p><p>You are invited to join your team's Vision and Tom workspace. This link creates your account and your personal night agent. It works once.</p><p><a href="${esc(created.url)}">Join</a></p>`,
  });
  console.log(`Emailed to ${created.email}.`);
} catch (err) {
  console.error(`The link was created but the email could not be sent (${safeError(err, [cfg.smtp.pass])}). Send the link above yourself.`);
  process.exit(1);
}
