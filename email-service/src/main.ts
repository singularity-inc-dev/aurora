import { mkdirSync } from "node:fs";
import { loadConfig } from "./config.ts";
import { githubClient } from "./github.ts";
import { safeError, sendPending, smtpSender } from "./mailer.ts";
import { boardApi, paperclipApi, personApi } from "./paperclip.ts";
import { syncPullRequests } from "./prsync.ts";
import { createLinkServer } from "./server.ts";

const log = (msg: string) => console.log(`[${new Date().toISOString()}] ${msg}`);
const cfg = loadConfig();
const api = paperclipApi(cfg);
const sendMail = smtpSender(cfg);
mkdirSync(cfg.stateDir, { recursive: true, mode: 0o700 });
const github = cfg.github.token ? githubClient({ token: cfg.github.token, apiUrl: cfg.github.apiUrl, gitUrl: cfg.github.gitUrl, stateDir: cfg.stateDir }) : null;
log(github ? "GitHub publishing is on" : "GitHub publishing is off (no token file); Approve merges locally unless the plugin asks for GitHub");

createLinkServer(api, log, { board: boardApi(cfg), person: personApi(cfg), github, signInUrl: cfg.paperclipPublicUrl }).listen(cfg.listenPort, cfg.listenHost, () =>
  log(`link pages on http://${cfg.listenHost}:${cfg.listenPort}`),
);

let busy = false;
let lastSync = 0;
async function poll(): Promise<void> {
  if (busy) return;
  busy = true;
  try {
    // Check pull requests first, so the morning email shows their latest state.
    if (github && Date.now() - lastSync >= cfg.github.syncMinutes * 60_000) {
      lastSync = Date.now();
      await syncPullRequests(api, github, log).catch((err) => log(`could not check pull requests: ${safeError(err, [cfg.github.token])}`));
    }
    const n = await sendPending(api, sendMail, log);
    if (n > 0) log(`sent ${n} briefing(s)`);
  } catch (err) {
    log(`could not fetch briefings: ${safeError(err)}`);
  } finally {
    busy = false;
  }
}
void poll();
setInterval(poll, cfg.pollSeconds * 1000);
