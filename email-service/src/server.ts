import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { GithubClient } from "./github.ts";
import { checkJoinForm, join } from "./join.ts";
import { confirmPage, errorPage, handoverPage, joinPage, joinResultPage, resultPage, signInFirstPage } from "./pages.ts";
import type { BoardApi, LinkOutcome, PersonApi, PluginApi, SessionApi } from "./paperclip.ts";

const TOKEN_RE = /^[A-Za-z0-9_-]{10,1500}\.[A-Za-z0-9_-]{20,100}$/;
const MAX_BODY = 2048;

const HEADERS = {
  "content-type": "text/html; charset=utf-8",
  "cache-control": "no-store",
  // The token in the address must never leak to other sites.
  "referrer-policy": "no-referrer",
  "x-frame-options": "DENY",
  "x-content-type-options": "nosniff",
  "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'",
};

function send(res: ServerResponse, status: number, html: string): void {
  res.writeHead(status, HEADERS);
  res.end(html);
}

async function readForm(req: IncomingMessage): Promise<URLSearchParams | null> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) return null;
    chunks.push(chunk as Buffer);
  }
  return new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
}

export interface ServerDeps {
  /** Needed for invite links (the board acts for the owner; the person signs themselves up). */
  board?: BoardApi;
  person?: PersonApi;
  /** Set when the owner's GitHub token is configured; only the Approve path uses it. */
  github?: GithubClient | null;
  /** Where a new person signs in after joining. */
  signInUrl?: string;
  /** Who is signed in to Paperclip (Hand over now). */
  session?: SessionApi;
  /** Approvals being published right now (the recovery of interrupted ones leaves these alone). */
  inFlight?: Set<string>;
}

/** Approve in GitHub mode: publish, then let the plugin record what happened. */
async function approve(api: PluginApi, deps: ServerDeps, token: string, outcome: LinkOutcome, log: (m: string) => void): Promise<LinkOutcome> {
  if (outcome.status !== "publish" || !("publish" in outcome)) return outcome;
  if (!deps.github) {
    log("approve needs GitHub, but no GitHub token is set up");
    return api.publishResult(token, { result: "failed", message: "the GitHub token is not set up on the server" });
  }
  // Whatever happens, report back: a lost answer holds the task until the recovery finds it (recover.ts).
  const id = outcome.publish.actionId;
  if (id) deps.inFlight?.add(id);
  try {
    const result = await deps.github.publish(outcome.publish).catch(() => ({ result: "failed" as const, message: "could not reach GitHub" }));
    log(`published to GitHub: ${result.result}`);
    return await api.publishResult(token, result);
  } finally {
    if (id) deps.inFlight?.delete(id);
  }
}

/**
 * GET /l/:token  shows what the link will do (no changes: mail scanners open links).
 * POST /l/:token does it. GET/POST /join/:token is the invite page.
 * The plugin makes every decision; this only renders pages and does what it is told.
 */
export function createLinkServer(api: PluginApi, log: (msg: string) => void = () => {}, deps: ServerDeps = {}): Server {
  return createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      if (url.pathname === "/health") {
        res.writeHead(200, { "content-type": "text/plain" });
        res.end("ok");
        return;
      }
      if (url.pathname === "/handover") {
        // Hand over now: only for the person signed in to Paperclip in this browser, and only from this site.
        if (!deps.session) return send(res, 503, errorPage("Hand over now is not set up on this server."));
        if (req.method !== "GET" && req.method !== "POST") {
          res.writeHead(405, { allow: "GET, POST" });
          res.end();
          return;
        }
        const me = await deps.session.whoIs(req.headers.cookie ?? "");
        if (!me) return send(res, 401, signInFirstPage(deps.signInUrl ?? "/"));
        if (req.method === "POST") {
          const origin = req.headers.origin;
          if (!origin || !deps.signInUrl || origin !== new URL(deps.signInUrl).origin) return send(res, 403, errorPage("Please use the button on this page."));
          const started = await api.startHandover(me.email);
          log(`hand over now: ${started.ok ? "started" : "refused"}`);
          return send(res, started.ok ? 200 : 409, handoverPage(await api.handoverStatus(me.email), started.ok ? "Started. Your agent is planning; approve the plan in Paperclip." : (started.message ?? "Not started.")));
        }
        return send(res, 200, handoverPage(await api.handoverStatus(me.email)));
      }
      const m = /^\/(l|join)\/([^/]+)$/.exec(url.pathname);
      if (!m) return send(res, 404, errorPage("Page not found."));
      const [, kind, token] = m as unknown as [string, "l" | "join", string];
      if (!TOKEN_RE.test(token)) return send(res, 400, resultPage({ status: "invalid", message: "This link is not valid." }));
      if (req.method !== "GET" && req.method !== "POST") {
        res.writeHead(405, { allow: "GET, POST" });
        res.end();
        return;
      }

      if (kind === "join") {
        if (!deps.board || !deps.person) return send(res, 503, errorPage("Invites are not set up on this server."));
        const check = await api.previewInvite(token);
        if (req.method === "GET") {
          log(`invite opened: ${check.status}`);
          return send(res, check.ok ? 200 : 400, joinPage(check));
        }
        const form = await readForm(req);
        if (!form) return send(res, 413, errorPage("Request too large."));
        if (!check.ok) return send(res, 409, joinPage(check));
        const input = checkJoinForm({ name: form.get("name"), password: form.get("password"), timezone: form.get("timezone") });
        if (typeof input === "string") return send(res, 400, joinPage(check, input, { name: form.get("name") ?? "", timezone: form.get("timezone") ?? "" }));
        const outcome = await join(api, deps.board, deps.person, token, input);
        log(`invite used: ${outcome.status}`);
        // e.g. an account from an earlier try with another password: show the form again (the invite still works).
        if (outcome.status === "needs-input") return send(res, 400, joinPage(check, outcome.message, { name: form.get("name") ?? "", timezone: form.get("timezone") ?? "" }));
        return send(res, outcome.ok ? 200 : 409, joinResultPage(outcome, deps.signInUrl ?? "/"));
      }

      if (req.method === "GET") {
        const check = await api.preview(token);
        log(`link opened: ${check.status}`);
        return send(res, check.ok ? 200 : 400, confirmPage(check));
      }
      const form = await readForm(req);
      if (!form) return send(res, 413, errorPage("Request too large."));
      const reason = form.get("reason");
      const outcome = await approve(api, deps, token, await api.execute(token, reason), log);
      log(`link used: ${outcome.status}`);
      if (outcome.status === "needs-reason") {
        const check = await api.preview(token);
        return send(res, 400, confirmPage(check, outcome.message));
      }
      return send(res, outcome.ok ? 200 : 409, resultPage(outcome));
    } catch {
      log("link request failed");
      send(res, 502, errorPage("Could not reach Paperclip. Please try again in a minute."));
    }
  });
}
