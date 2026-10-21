import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { confirmPage, errorPage, resultPage } from "./pages.ts";
import type { PluginApi } from "./paperclip.ts";

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

/**
 * GET /l/:token  shows what the link will do (no changes: mail scanners open links).
 * POST /l/:token does it. The plugin makes every decision; this only renders pages.
 */
export function createLinkServer(api: PluginApi, log: (msg: string) => void = () => {}): Server {
  return createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      if (url.pathname === "/health") {
        res.writeHead(200, { "content-type": "text/plain" });
        res.end("ok");
        return;
      }
      const m = /^\/l\/([^/]+)$/.exec(url.pathname);
      if (!m) return send(res, 404, errorPage("Page not found."));
      const token = m[1]!;
      if (!TOKEN_RE.test(token)) return send(res, 400, resultPage({ ok: false, status: "invalid", message: "This link is not valid." }));
      const action = `/l/${token}`;

      if (req.method === "GET") {
        const check = await api.preview(token);
        log(`link opened: ${check.status}`);
        return send(res, check.ok ? 200 : 400, confirmPage(check, action));
      }
      if (req.method === "POST") {
        const form = await readForm(req);
        if (!form) return send(res, 413, errorPage("Request too large."));
        const reason = form.get("reason");
        const outcome = await api.execute(token, reason);
        log(`link used: ${outcome.status}`);
        if (outcome.status === "needs-reason") {
          const check = await api.preview(token);
          return send(res, 400, confirmPage(check, action, outcome.message));
        }
        return send(res, outcome.ok ? 200 : 409, resultPage(outcome));
      }
      res.writeHead(405, { allow: "GET, POST" });
      res.end();
    } catch {
      log("link request failed");
      send(res, 502, errorPage("Could not reach Paperclip. Please try again in a minute."));
    }
  });
}
