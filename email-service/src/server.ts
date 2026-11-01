import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { GithubClient } from "./github.ts";
import { checkJoinForm, join } from "./join.ts";
import { confirmPage, errorPage, handoverPage, joinPage, joinResultPage, resultPage, signInFirstPage, type HandoverForm } from "./pages.ts";
import type { BoardApi, HandoverTask, LinkOutcome, PersonApi, PluginApi, SessionApi } from "./paperclip.ts";

const TOKEN_RE = /^[A-Za-z0-9_-]{10,1500}\.[A-Za-z0-9_-]{20,100}$/;
const MAX_BODY = 2048;
/** The Hand over form carries a note per ticket (up to 20 tickets). */
const MAX_HANDOVER_BODY = 128 * 1024;

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

async function readForm(req: IncomingMessage, max = MAX_BODY): Promise<URLSearchParams | null> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > max) return null;
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
  /** Who is signed in to Paperclip (the Hand over page, and Approve/Reject: only the owner). */
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
        // The owner's own page: only for the person signed in to Paperclip in this browser, and only from this site.
        if (!deps.session) return send(res, 503, errorPage("The Hand over page is not set up on this server."));
        if (req.method !== "GET" && req.method !== "POST") {
          res.writeHead(405, { allow: "GET, POST" });
          res.end();
          return;
        }
        const me = await deps.session.whoIs(req.headers.cookie ?? "");
        if (!me) return send(res, 401, signInFirstPage(deps.signInUrl ?? "/"));
        if (req.method === "GET") return send(res, 200, handoverPage(await api.handoverStatus(me.email)));
        const origin = req.headers.origin;
        if (!origin || !deps.signInUrl || origin !== new URL(deps.signInUrl).origin) return send(res, 403, errorPage("Please use the buttons on this page."));
        const form = await readForm(req, MAX_HANDOVER_BODY);
        if (!form) return send(res, 413, errorPage("Too much text. Please shorten your notes."));
        const action = form.get("action");
        if (action === "withdraw") {
          const done = await api.withdrawHandover(me.email);
          log(`hand over: withdrawn ${done.ok ? "ok" : "refused"}`);
          return send(res, 200, handoverPage(await api.handoverStatus(me.email), done.message ?? null));
        }
        if (action === "suggest") {
          const asked = await api.askSuggestions(me.email);
          log(`hand over: suggestions ${asked.ok ? "asked" : "refused"}`);
          return send(res, asked.ok ? 200 : 409, handoverPage(await api.handoverStatus(me.email), asked.message ?? null));
        }
        if (action !== "now" && action !== "scheduled") return send(res, 400, errorPage("Please use the buttons on this page."));
        const { tasks, form: typed } = handoverTasks(form);
        if (tasks.length === 0) return send(res, 400, handoverPage(await api.handoverStatus(me.email), "Tick at least one ticket.", typed));
        const started = await api.startHandover(me.email, action, tasks);
        log(`hand over (${action}): ${started.ok ? "handed over" : "refused"}`);
        const message = { text: started.message ?? (started.ok ? "Handed over." : "Nothing was handed over."), overlaps: started.overlaps, notes: started.notes };
        // On a refusal the page keeps everything the owner typed.
        return send(res, started.ok ? 200 : 409, handoverPage(await api.handoverStatus(me.email), message, started.ok ? null : typed));
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

      // Only the task's owner decides it: the person signed in to Paperclip in this browser must be the owner.
      if (!deps.session) return send(res, 503, errorPage("Approve and Reject need the Paperclip sign-in check, which is not set up on this server."));
      const viewer = await deps.session.whoIs(req.headers.cookie ?? "");
      if (req.method === "GET") {
        const check = await api.preview(token);
        log(`link opened: ${check.status}`);
        return send(res, check.ok ? 200 : 400, confirmPage(check, null, viewer, deps.signInUrl ?? "/"));
      }
      const form = await readForm(req);
      if (!form) return send(res, 413, errorPage("Request too large."));
      if (!viewer) return send(res, 401, confirmPage(await api.preview(token), null, null, deps.signInUrl ?? "/"));
      const reason = form.get("reason");
      const outcome = await approve(api, deps, token, await api.execute(token, reason, viewer.email), log);
      log(`link used: ${outcome.status}`);
      if (outcome.status === "needs-reason") {
        const check = await api.preview(token);
        return send(res, 400, confirmPage(check, outcome.message, viewer, deps.signInUrl ?? "/"));
      }
      return send(res, outcome.ok ? 200 : 409, resultPage(outcome));
    } catch {
      log("link request failed");
      send(res, 502, errorPage("Could not reach Paperclip. Please try again in a minute."));
    }
  });
}

/**
 * The ticked tickets and their notes, from the Hand over form. Field names carry
 * the ticket id ("what:<id>"); the plugin checks every value again.
 */
export function handoverTasks(form: URLSearchParams): { tasks: HandoverTask[]; form: HandoverForm } {
  const picked = [...new Set(form.getAll("pick"))].slice(0, 20);
  const values: Record<string, string> = {};
  for (const [key, value] of form) if (/^(what|done|files|min|cents):/.test(key)) values[key] = value;
  const get = (field: string, id: string) => values[`${field}:${id}`] ?? "";
  const tasks = picked.map((id) => ({
    issueId: id,
    what: get("what", id),
    doneWhen: get("done", id),
    files: get("files", id),
    maxMinutes: get("min", id),
    budgetCents: get("cents", id),
  }));
  return { tasks, form: { picked, values } };
}
