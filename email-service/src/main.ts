import { loadConfig } from "./config.ts";
import { sendPending, smtpSender } from "./mailer.ts";
import { paperclipApi } from "./paperclip.ts";
import { createLinkServer } from "./server.ts";

const log = (msg: string) => console.log(`[${new Date().toISOString()}] ${msg}`);
const cfg = loadConfig();
const api = paperclipApi(cfg);
const sendMail = smtpSender(cfg);

createLinkServer(api, log).listen(cfg.listenPort, cfg.listenHost, () => log(`link pages on http://${cfg.listenHost}:${cfg.listenPort}`));

let busy = false;
async function poll(): Promise<void> {
  if (busy) return;
  busy = true;
  try {
    const n = await sendPending(api, sendMail, log);
    if (n > 0) log(`sent ${n} briefing(s)`);
  } catch (err) {
    log(`could not fetch briefings: ${err instanceof Error ? err.message : "unknown error"}`);
  } finally {
    busy = false;
  }
}
void poll();
setInterval(poll, cfg.pollSeconds * 1000);
