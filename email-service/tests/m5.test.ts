import { mkdtempSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.ts";
import type { GithubClient } from "../src/github.ts";
import { checkJoinForm, join } from "../src/join.ts";
import type { BoardApi, LinkCheck, LinkOutcome, PersonApi, PluginApi, PublishResult } from "../src/paperclip.ts";
import { syncPullRequests } from "../src/prsync.ts";
import { createLinkServer } from "../src/server.ts";

const TOKEN = "eyJ2IjoxLCJhIjoiYWN0In0." + "s".repeat(43);
const PUBLISH = { repo: "acme/app", worktree: "/w", branch: "vt/T-1", baseBranch: "main", expectedHead: "a".repeat(40), title: "T-1", body: "b" };

function plugin(over: Partial<PluginApi> = {}): PluginApi & { calls: string[] } {
  const calls: string[] = [];
  const base: PluginApi = {
    pendingEmails: async () => [],
    markSent: async () => undefined,
    preview: async (): Promise<LinkCheck> => ({ ok: true, status: "valid", message: "ok", kind: "approve", task: { identifier: "T-1", title: "x" }, github: "acme/app" }),
    execute: async (): Promise<LinkOutcome> => {
      calls.push("execute");
      return { ok: true, status: "publish", message: "publish", publish: PUBLISH };
    },
    publishResult: async (_t, r): Promise<LinkOutcome> => {
      calls.push(`result:${r.result}`);
      return r.result === "waiting" ? { ok: true, status: "waiting", message: `pull request #${r.number} is waiting for review` } : r.result === "merged" ? { ok: true, status: "merged", message: "merged" } : { ok: false, status: "refused", message: r.message };
    },
    waitingPullRequests: async () => ({ repo: "acme/app", pullRequests: [{ taskId: "t1", number: 4, url: "u", headSha: "a".repeat(40) }, { taskId: "t2", number: 5, url: "u", headSha: "b".repeat(40) }] }),
    pullRequestUpdate: async (id, state) => void calls.push(`update:${id}:${state}`),
    createInvite: async () => ({ ok: false }),
    previewInvite: async () => ({ ok: true, status: "valid", message: "ok", email: "cy@example.com", timezone: "Europe/Berlin" }),
    claimInvite: async () => {
      calls.push("claim");
      return { ok: true, status: "claimed", plan: { inviteId: "inv-1", email: "cy@example.com", timezone: "Europe/Berlin", defaults: { nightStartHour: 22, nightBudgetCapCents: 300, maxTasksPerNight: 3, agentAdapterType: "process", agentAdapterConfig: { command: "pwd" }, agentMonthlyBudgetCents: 3000 } } };
    },
    finishInvite: async (_id, r) => {
      calls.push(`finish:${r.ok ? "ok" : r.message}`);
      return { ok: true, message: "joined" };
    },
  };
  return Object.assign(base, over, { calls });
}

function github(result: PublishResult | Error): GithubClient & { published: number } {
  const g = {
    published: 0,
    async publish() {
      g.published += 1;
      if (result instanceof Error) throw result;
      return result;
    },
    async status(_repo: string, pr: { number: number }) {
      return pr.number === 4 ? { state: "merged" as const, mergeSha: "c".repeat(40) } : { state: "open" as const, mergeSha: null };
    },
  };
  return g;
}

let server: ReturnType<typeof createLinkServer> | null = null;
afterEach(() => server?.close());
async function start(api: PluginApi, deps: Parameters<typeof createLinkServer>[2] = {}): Promise<string> {
  server = createLinkServer(api, () => {}, deps);
  await new Promise<void>((r) => server!.listen(0, "127.0.0.1", r));
  return `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
}
const post = (url: string, body = "") => fetch(url, { method: "POST", body, headers: { "content-type": "application/x-www-form-urlencoded" } });

describe("Approve with GitHub", () => {
  it("the confirm page says what will happen on GitHub", async () => {
    const base = await start(plugin());
    const html = await (await fetch(`${base}/l/${TOKEN}`)).text();
    expect(html).toContain("Push <strong>T-1 x</strong> to GitHub (acme/app), open a pull request and merge it.");
    expect(html).toContain('<form method="post">');
  });

  it("blocked by protection: the confirmation page says waiting for review", async () => {
    const api = plugin();
    const gh = github({ result: "waiting", number: 3, url: "https://github.com/acme/app/pull/3", reason: "review required" });
    const base = await start(api, { github: gh });
    const res = await post(`${base}/l/${TOKEN}`);
    const html = await res.text();
    expect(html).toContain("<h1>Waiting for review</h1>");
    expect(api.calls).toEqual(["execute", "result:waiting"]);
    expect(gh.published).toBe(1);
  });

  it("without a token on the server, nothing is published and the task is released", async () => {
    const api = plugin();
    const base = await start(api, { github: null });
    const html = await (await post(`${base}/l/${TOKEN}`)).text();
    expect(html).toContain("<h1>Not done</h1>");
    expect(api.calls).toEqual(["execute", "result:failed"]);
  });

  it("an unexpected GitHub error is still reported back, so the task is never stuck", async () => {
    const api = plugin();
    const base = await start(api, { github: github(new Error("socket hang up")) });
    await post(`${base}/l/${TOKEN}`);
    expect(api.calls).toEqual(["execute", "result:failed"]);
  });

  it("the sync reports merged pull requests and leaves open ones waiting", async () => {
    const api = plugin();
    expect(await syncPullRequests(api, github({ result: "failed", message: "" }))).toBe(1);
    expect(api.calls).toEqual(["update:t1:merged"]);
  });
});

function fakePaperclip() {
  const log: string[] = [];
  let config: Record<string, unknown> = { links: { baseUrl: "x" }, people: [{ email: "ana@example.com", agentId: "a1" }] };
  const board: BoardApi = {
    createHumanInvite: async () => (log.push("paperclip-invite"), "pc-invite"),
    createAgent: async (input) => (log.push(`agent:${input.name}:${input.adapterType}:${input.budgetMonthlyCents}`), "agent-cy"),
    getAgent: async () => ({}),
    getPluginConfig: async () => config,
    savePluginConfig: async (c) => void ((config = c), log.push("saved")),
  };
  const person: PersonApi = {
    signUp: async (i) => (log.push(`signup:${i.email}:${i.name}`), { cookie: "s=1", userId: "u-cy" }),
    acceptInvite: async (cookie, token) => void log.push(`accept:${cookie}:${token}`),
  };
  return { board, person, log, config: () => config };
}

describe("invite page and join", () => {
  it("opening the invite changes nothing; the form creates account, membership, agent and settings row", async () => {
    const api = plugin();
    const pc = fakePaperclip();
    const base = await start(api, { board: pc.board, person: pc.person, signInUrl: "https://team.example.com" });
    const page = await (await fetch(`${base}/join/${TOKEN}`)).text();
    expect(page).toContain("You were invited as <strong>cy@example.com</strong>");
    expect(page).toContain('value="Europe/Berlin"');
    expect(api.calls).toEqual([]);
    const res = await post(`${base}/join/${TOKEN}`, "name=Cy+Ng&password=correct-horse-battery&timezone=Europe%2FBerlin");
    const html = await res.text();
    expect(res.status).toBe(200);
    expect(html).toContain("<h1>You&#39;re in</h1>");
    expect(html).toContain('href="https://team.example.com"');
    expect(pc.log).toEqual(["paperclip-invite", "signup:cy@example.com:Cy Ng", "accept:s=1:pc-invite", "agent:Cy Ng's night agent:process:3000", "saved"]);
    expect((pc.config().people as unknown[])[1]).toEqual({ email: "cy@example.com", agentId: "agent-cy", timezone: "Europe/Berlin", nightStartHour: 22, maxTasksPerNight: 3, nightBudgetCapCents: 300, secrets: [] });
    expect(api.calls).toEqual(["claim", "finish:ok"]);
  });

  it("a short password is refused before the invite is used up", async () => {
    const api = plugin();
    const pc = fakePaperclip();
    const base = await start(api, { board: pc.board, person: pc.person });
    const html = await (await post(`${base}/join/${TOKEN}`, "name=Cy&password=short")).text();
    expect(html).toContain("Please choose a password of 12 to 128 characters.");
    expect(api.calls).toEqual([]);
    expect(pc.log).toEqual([]);
  });

  it("a used or expired invite shows why and creates nothing", async () => {
    for (const status of ["already-used", "expired"] as const) {
      const api = plugin({ previewInvite: async () => ({ ok: false, status, message: `This invite link ${status}.` }) });
      const pc = fakePaperclip();
      const base = await start(api, { board: pc.board, person: pc.person });
      expect((await fetch(`${base}/join/${TOKEN}`)).status).toBe(400);
      const res = await post(`${base}/join/${TOKEN}`, "name=Cy&password=correct-horse-battery");
      expect(res.status).toBe(409);
      expect(await res.text()).toContain(status === "expired" ? "Invite expired" : "Invite already used");
      expect(pc.log).toEqual([]);
      server?.close();
    }
  });

  it("a failure part-way is recorded on the invite, and the page says to ask for a new link", async () => {
    const api = plugin();
    const pc = fakePaperclip();
    pc.board.createAgent = async () => {
      throw new (await import("../src/paperclip.ts")).PaperclipError(403, "Paperclip answered 403 for POST /api/companies/:id/agents");
    };
    const out = await join(api, pc.board, pc.person, TOKEN, { name: "Cy", password: "correct-horse-battery", timezone: null });
    expect(out).toMatchObject({ ok: false, status: "failed" });
    expect(out.message).toContain("creating your agent");
    expect(api.calls.at(-1)).toContain("failed while creating your agent");
  });

  it("checks the form", () => {
    expect(checkJoinForm({ name: " ", password: "x".repeat(12) })).toContain("name");
    expect(checkJoinForm({ name: "Cy", password: "x".repeat(129) })).toContain("password");
    expect(checkJoinForm({ name: "  Cy   Ng ", password: "x".repeat(12), timezone: "" })).toEqual({ name: "Cy Ng", password: "x".repeat(12), timezone: null });
  });
});

describe("secrets come from files", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "vt-cfg-"));
  const file = (name: string, value: string) => {
    const p = path.join(dir, name);
    writeFileSync(p, `${value}\n`, { mode: 0o600 });
    return p;
  };

  it("reads the SMTP password, Paperclip key and GitHub token from files", () => {
    const cfg = loadConfig({
      VT_COMPANY_ID: "c",
      SMTP_HOST: "smtp.example.com",
      SMTP_PORT: "587",
      SMTP_REQUIRE_TLS: "true",
      SMTP_USER: "me@example.com",
      SMTP_PASS_FILE: file("smtp", "pw-value"),
      PAPERCLIP_API_KEY_FILE: file("pc", "pc-value"),
      GITHUB_TOKEN_FILE: file("gh", "gh-value"),
    });
    expect(cfg.smtp).toMatchObject({ host: "smtp.example.com", port: 587, secure: false, requireTls: true, user: "me@example.com", pass: "pw-value" });
    expect(cfg.paperclipApiKey).toBe("pc-value");
    expect(cfg.github.token).toBe("gh-value");
    expect(loadConfig({ VT_COMPANY_ID: "c", SMTP_PORT: "465" }).smtp.secure).toBe(true);
  });

  it("refuses a GitHub token given as a plain environment variable (other processes of the same user can read those)", () => {
    expect(() => loadConfig({ VT_COMPANY_ID: "c", GITHUB_TOKEN: "x" })).toThrow("GITHUB_TOKEN may only be given as a file");
  });

  it("a missing secret file names the setting, not the value", () => {
    expect(() => loadConfig({ VT_COMPANY_ID: "c", SMTP_PASS_FILE: "/nonexistent/x" })).toThrow("cannot read the file named by SMTP_PASS_FILE");
  });
});
