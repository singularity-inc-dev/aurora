/**
 * Bug 3: every network step of the email service has a time limit, and calls
 * that are safe to repeat are retried with backoff, so one slow answer cannot
 * hang the handback emails or an Approve.
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { githubClient } from "../src/github.ts";
import { smtpOptions } from "../src/mailer.ts";
import { boardApi, limitedFetch, paperclipApi } from "../src/paperclip.ts";

const cfg = { paperclipUrl: "http://pc", paperclipPublicUrl: "http://pc", plugin: "p", companyId: "co", paperclipApiKey: null } as never;

/** A server that never answers (but stops when the call is aborted). */
const silent = (calls: string[]) =>
  ((url: string, init?: RequestInit) => {
    calls.push(`${init?.method ?? "GET"} ${String(url)}`);
    return new Promise((_, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal!.reason)));
  }) as unknown as typeof fetch;

/** Fails `failures` times with `status` (0 = network error), then answers 200 with `body`. */
const flaky = (calls: string[], failures: number, status: number, body: unknown) =>
  (async (url: string, init?: RequestInit) => {
    calls.push(`${init?.method ?? "GET"} ${String(url)}`);
    if (failures-- > 0) {
      if (status === 0) throw new TypeError("fetch failed");
      return new Response("{}", { status });
    }
    return new Response(JSON.stringify(body), { status: 200 });
  }) as unknown as typeof fetch;

const fast = { timeoutMs: 100, baseDelayMs: 1 };

describe("calls to Paperclip", () => {
  it("a call that never answers is given up on", async () => {
    const calls: string[] = [];
    const api = paperclipApi(cfg, limitedFetch(silent(calls), fast));
    const started = Date.now();
    await expect(api.pendingEmails()).rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(3000);
  });

  it("reads are retried with backoff after a network error or a 5xx answer", async () => {
    const calls: string[] = [];
    const api = paperclipApi(cfg, limitedFetch(flaky(calls, 2, 502, { emails: [] }), fast));
    expect(await api.pendingEmails()).toEqual([]);
    expect(calls).toHaveLength(3);
    const net: string[] = [];
    expect(await paperclipApi(cfg, limitedFetch(flaky(net, 1, 0, { emails: [] }), fast)).pendingEmails()).toEqual([]);
    expect(net).toHaveLength(2);
  });

  it("marking an email sent is retried (it is safe to repeat)", async () => {
    const calls: string[] = [];
    await paperclipApi(cfg, limitedFetch(flaky(calls, 1, 503, {}), fast)).markSent("b1");
    expect(calls).toHaveLength(2);
  });

  it("a one-time action (Approve) is never retried, and a 4xx is never retried", async () => {
    const calls: string[] = [];
    await expect(paperclipApi(cfg, limitedFetch(flaky(calls, 1, 502, {}), fast)).execute("tok", null)).rejects.toThrow("502");
    expect(calls).toHaveLength(1);
    const four: string[] = [];
    await expect(paperclipApi(cfg, limitedFetch(flaky(four, 1, 403, { emails: [] }), fast)).pendingEmails()).rejects.toThrow("403");
    expect(four).toHaveLength(1);
  });

  it("the default fetch of every API has a limit", async () => {
    const calls: string[] = [];
    // boardApi with a silent server: must give up (it uses limitedFetch inside).
    const board = boardApi(cfg, limitedFetch(silent(calls), fast));
    await expect(board.getPluginConfig()).rejects.toThrow();
  });
});

describe("calls to GitHub", () => {
  it("an API call that never answers is given up on, and the approval fails cleanly", async () => {
    const calls: string[] = [];
    const root = mkdtempSync(path.join(tmpdir(), "vt-gh-"));
    const gh = githubClient({ token: "t0k3n", apiUrl: "http://gh/api", gitUrl: "http://gh", stateDir: root }, limitedFetch(silent(calls), fast), async () => undefined);
    const started = Date.now();
    await expect(gh.status("acme/app", { number: 1 } as never)).rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(3000);
  });

  it("git push past its limit is stopped", async () => {
    const bin = mkdtempSync(path.join(tmpdir(), "vt-stuck-git-"));
    writeFileSync(path.join(bin, "git"), "#!/bin/sh\nexec sleep 30\n", { mode: 0o755 });
    const saved = process.env.PATH;
    process.env.PATH = `${bin}:${saved}`;
    try {
      const gh = githubClient({ token: "t0k3n", apiUrl: "http://gh/api", gitUrl: "http://gh", stateDir: mkdtempSync(path.join(tmpdir(), "vt-gh-")), gitTimeoutMs: 300 }, fetch, async () => undefined);
      const started = Date.now();
      const res = await gh.publish({ repo: "acme/app", branch: "vt/t1", baseBranch: "main", expectedHead: "a".repeat(40), worktree: "/nowhere", title: "T", body: "" } as never);
      expect(res).toMatchObject({ result: "failed" });
      expect(Date.now() - started).toBeLessThan(5000);
    } finally {
      process.env.PATH = saved;
    }
  });
});

describe("SMTP", () => {
  it("has explicit limits for connecting, the greeting and a silent connection", () => {
    const o = smtpOptions({ smtp: { host: "mail", port: 587, secure: false, requireTls: true, user: null, pass: null, caFile: null } } as never);
    expect(o.connectionTimeout).toBeLessThanOrEqual(30_000);
    expect(o.greetingTimeout).toBeLessThanOrEqual(30_000);
    expect(o.socketTimeout).toBeLessThanOrEqual(120_000);
  });
});
