import { mkdtempSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.ts";
import type { GithubClient } from "../src/github.ts";
import { checkJoinForm, join } from "../src/join.ts";
import type { BoardApi, LinkCheck, LinkOutcome, PersonApi, PluginApi, PublishResult } from "../src/paperclip.ts";
import { paperclipApi, PaperclipError } from "../src/paperclip.ts";
import { syncPullRequests } from "../src/prsync.ts";
import { recoverStuckApprovals } from "../src/recover.ts";
import { createLinkServer } from "../src/server.ts";

const TOKEN = "eyJ2IjoxLCJhIjoiYWN0In0." + "s".repeat(43);
const PUBLISH = { actionId: "act-1", repo: "acme/app", worktree: "/w", branch: "vt/T-1", baseBranch: "main", expectedHead: "a".repeat(40), title: "T-1", body: "b" };

const PLAN = {
  inviteId: "inv-1",
  email: "cy@example.com",
  timezone: "Europe/Berlin",
  defaults: { handoverStartHour: 22, handoverBudgetCapCents: 300, maxTasksPerHandover: 3, agentAdapterType: "claude_local", agentAdapterConfig: { model: "x" }, agentMonthlyBudgetCents: 3000 },
  // made by vt-invite: the new agent's own system user and environment
  agent: { agentEnvironmentId: "env-cy", agentUser: "vt-a-cy", checksKey: { type: "secret_ref" as const, secretId: "ck-cy" } },
};

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
      return { ok: true, status: "claimed", plan: PLAN };
    },
    handoverStatus: async (email) => ({ ok: true, email, timezone: "UTC", handoverStartHour: 22, handovers: [] }),
    startHandover: async (email) => (calls.push(`start:${email}`), { ok: true, handoverKey: "2026-10-24T14:05:00" }),
    numbers: async () => ({ team: {} }),
    numbersCsv: async () => "Date\r\n",
    finishInvite: async (_id, r) => {
      calls.push(`finish:${r.ok ? "ok" : r.message}`);
      return r.ok ? { ok: true, message: "joined" } : { ok: true, message: "recorded", retry: true };
    },
    stuckApprovals: async () => [{ actionId: "act-1", taskId: "t1", publish: PUBLISH }, { actionId: "act-2", taskId: "t2", publish: { ...PUBLISH, actionId: "act-2" } }],
    recoverApproval: async (id, minutes, r): Promise<LinkOutcome> => {
      calls.push(`recover:${id}:${minutes}:${r.result}`);
      return { ok: true, status: "merged", message: "merged" };
    },
  };
  return Object.assign(base, over, { calls });
}

function github(result: PublishResult | Error, onPublish: () => Promise<void> = async () => undefined): GithubClient & { published: number } {
  const g = {
    published: 0,
    async publish() {
      g.published += 1;
      await onPublish();
      if (result instanceof Error) throw result;
      return result;
    },
    async resume() {
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

  it("an approval being published is marked in flight until it reports back", async () => {
    const api = plugin();
    const inFlight = new Set<string>();
    let seen: string[] = [];
    const gh = github({ result: "merged", number: 3, url: "https://github.com/acme/app/pull/3", mergeSha: "c".repeat(40) }, async () => void (seen = [...inFlight]));
    const base = await start(api, { github: gh, inFlight });
    await post(`${base}/l/${TOKEN}`);
    expect(seen).toEqual(["act-1"]);
    expect(inFlight.size).toBe(0);
  });

  // Spec gap 27: a crash mid-approval must not leave a task "in progress".
  it("interrupted approvals are finished on GitHub and reported; ones still in flight are left alone", async () => {
    const api = plugin();
    const n = await recoverStuckApprovals(api, github({ result: "merged", number: 3, url: "u", mergeSha: "c".repeat(40) }), new Set(["act-2"]), 15);
    expect(n).toBe(1);
    expect(api.calls).toEqual(["recover:act-1:15:merged"]);
  });

  it("when GitHub cannot be asked, the interrupted approval is left for the next round", async () => {
    const api = plugin();
    expect(await recoverStuckApprovals(api, github(new Error("GitHub answered 502 when listing pull requests")), new Set(), 15)).toBe(0);
    expect(api.calls).toEqual([]);
  });

  it("the sync reports merged pull requests and leaves open ones waiting", async () => {
    const api = plugin();
    expect(await syncPullRequests(api, github({ result: "failed", message: "" }))).toBe(1);
    expect(api.calls).toEqual(["update:t1:merged"]);
  });
});

/** A stand-in Paperclip that remembers what earlier join tries made (accounts, members, agents). */
function fakePaperclip() {
  const log: string[] = [];
  let config: Record<string, unknown> = { links: { baseUrl: "x" }, people: [{ email: "ana@example.com", agentId: "a1" }] };
  const accounts = new Map<string, string>(); // email -> password
  const members = new Set<string>();
  const agents: Array<{ id: string; defaultEnvironmentId: string | null }> = [];
  const board: BoardApi = {
    createHumanInvite: async () => (log.push("paperclip-invite"), "pc-invite"),
    createAgent: async (input) => {
      log.push(`agent:${input.name}:${input.adapterType}:${input.budgetMonthlyCents}:${input.defaultEnvironmentId}:${JSON.stringify(input.adapterConfig)}`);
      const id = agents.length === 0 ? "agent-cy" : `agent-cy-${agents.length + 1}`;
      agents.push({ id, defaultEnvironmentId: input.defaultEnvironmentId ?? null });
      return id;
    },
    request: async <T,>() => ({}) as T,
    getAgent: async () => ({}),
    findAgentByEnvironment: async (env) => agents.find((a) => a.defaultEnvironmentId === env)?.id ?? null,
    lockAgent: async (id) => void log.push(`lock:${id}`),
    isMember: async (userId) => members.has(userId),
    getPluginConfig: async () => config,
    savePluginConfig: async (c) => void ((config = c), log.push("saved")),
  };
  const person: PersonApi = {
    signUp: async (i) => {
      if (accounts.has(i.email)) throw new PaperclipError(409, "an account with this email already exists");
      accounts.set(i.email, i.password);
      log.push(`signup:${i.email}:${i.name}`);
      return { cookie: "s=1", userId: "u-cy" };
    },
    signIn: async (i) => {
      if (accounts.get(i.email) !== i.password) throw new PaperclipError(401, "the password does not match the existing account");
      log.push(`signin:${i.email}`);
      return { cookie: "s=2", userId: "u-cy" };
    },
    acceptInvite: async (cookie, token) => void (members.add("u-cy"), log.push(`accept:${cookie}:${token}`)),
  };
  return { board, person, log, agents, config: () => config };
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
    // The agent runs in its own environment (its own system user), with Claude's CLI engine.
    expect(pc.log).toEqual(["signup:cy@example.com:Cy Ng", "paperclip-invite", "accept:s=1:pc-invite", `agent:Cy Ng's agent:claude_local:3000:env-cy:{"model":"x","engine":"cli"}`, "saved"]);
    expect((pc.config().people as unknown[])[1]).toEqual({
      email: "cy@example.com",
      agentId: "agent-cy",
      agentEnvironmentId: "env-cy",
      agentUser: "vt-a-cy",
      checksKey: { type: "secret_ref", secretId: "ck-cy" },
      timezone: "Europe/Berlin",
      handoverStartHour: 22,
      maxTasksPerHandover: 3,
      handoverBudgetCapCents: 300,
      secrets: [],
    });
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

  it("a failure part-way is recorded on the invite with what was made, and the page says the link still works", async () => {
    const api = plugin();
    const pc = fakePaperclip();
    pc.board.createAgent = async () => {
      throw new (await import("../src/paperclip.ts")).PaperclipError(403, "Paperclip answered 403 for POST /api/companies/:id/agents");
    };
    const out = await join(api, pc.board, pc.person, TOKEN, { name: "Cy", password: "correct-horse-battery", timezone: null });
    expect(out).toMatchObject({ ok: false, status: "failed" });
    expect(out.message).toContain("creating your agent");
    expect(out.message).toContain("Your invite link still works");
    expect(api.calls.at(-1)).toContain("failed while creating your agent");
  });

  // Spec gap 27: a join that fails halfway must not use up the invite.
  it("a second try after a failure halfway reuses the account and the agent the first try made", async () => {
    const pc = fakePaperclip();
    const finishes: unknown[] = [];
    const resume = { userId: null as string | null, agentId: null as string | null };
    const api = plugin({
      claimInvite: async () => ({ ok: true, status: "claimed", plan: { ...PLAN, attempt: finishes.length + 1, resume } }),
      finishInvite: async (_id, r) => (finishes.push(r), r.ok ? { ok: true, message: "joined" } : { ok: true, message: "recorded", retry: true }),
    });
    const save = pc.board.savePluginConfig;
    pc.board.savePluginConfig = async () => {
      throw new PaperclipError(500, "Paperclip answered 500 for POST /api/plugins/:id/config");
    };
    const form = { name: "Cy", password: "correct-horse-battery", timezone: null };
    const first = await join(api, pc.board, pc.person, TOKEN, form);
    expect(first).toMatchObject({ ok: false, status: "failed" });
    expect(first.message).toContain("saving your settings");
    expect(finishes[0]).toMatchObject({ ok: false, attempt: 1, userId: "u-cy", agentId: "agent-cy" });

    pc.board.savePluginConfig = save;
    pc.log.length = 0;
    const second = await join(api, pc.board, pc.person, TOKEN, form);
    expect(second).toMatchObject({ ok: true, status: "joined" });
    // Signed in to the account from the first try, already a member, the same agent (found by its own environment) locked again.
    expect(pc.log).toEqual(["signin:cy@example.com", "lock:agent-cy", "saved"]);
    expect(pc.agents).toHaveLength(1);
    expect(finishes[1]).toMatchObject({ ok: true, attempt: 2, agentId: "agent-cy", userId: "u-cy" });
    expect((pc.config().people as Array<{ email: string }>).filter((p) => p.email === "cy@example.com")).toHaveLength(1);

    // A third run (as if the report back was lost) changes nothing: the settings row is already there.
    pc.log.length = 0;
    expect(await join(api, pc.board, pc.person, TOKEN, form)).toMatchObject({ ok: true });
    expect(pc.log).toEqual(["signin:cy@example.com", "lock:agent-cy"]);
  });

  it("a later try with a different password shows the form again; the invite stays usable", async () => {
    const pc = fakePaperclip();
    const api = plugin();
    pc.board.createAgent = async () => {
      throw new PaperclipError(503, "Paperclip answered 503");
    };
    await join(api, pc.board, pc.person, TOKEN, { name: "Cy", password: "correct-horse-battery", timezone: null });
    const base = await start(api, { board: pc.board, person: pc.person });
    const res = await post(`${base}/join/${TOKEN}`, "name=Cy&password=another-password-here");
    expect(res.status).toBe(400);
    const html = await res.text();
    expect(html).toContain("Please type the same password you chose then.");
    expect(html).toContain('<form method="post"');
    expect(api.calls.at(-1)).toContain("failed while creating your account");
  });

  it("after the last allowed try the page says to ask for a new link", async () => {
    const pc = fakePaperclip();
    const api = plugin({ finishInvite: async () => ({ ok: true, message: "recorded", retry: false }) });
    pc.board.createAgent = async () => {
      throw new PaperclipError(503, "Paperclip answered 503");
    };
    const out = await join(api, pc.board, pc.person, TOKEN, { name: "Cy", password: "correct-horse-battery", timezone: null });
    expect(out.message).toContain("This link is now used up; please ask for a new one.");
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

describe("Hand over now page", () => {
  const SITE = "https://team.example.com";
  const session = { whoIs: async (cookie: string) => (cookie.includes("ana-session") ? { email: "ana@example.com" } : null) };

  it("is only for the person signed in to Paperclip", async () => {
    const api = plugin();
    const base = await start(api, { session, signInUrl: SITE });
    const anon = await fetch(`${base}/handover`);
    expect(anon.status).toBe(401);
    expect(await anon.text()).toContain("sign in to Paperclip");
    const page = await (await fetch(`${base}/handover`, { headers: { cookie: "s=ana-session" } })).text();
    expect(page).toContain("Signed in as <strong>ana@example.com</strong>");
    expect(page).toContain("Hand over now</button>");
    expect(api.calls).toEqual([]);
  });

  it("starts the signed-in owner's handover, and only from this site's own page", async () => {
    const api = plugin();
    const base = await start(api, { session, signInUrl: SITE });
    const elsewhere = await fetch(`${base}/handover`, { method: "POST", headers: { cookie: "s=ana-session", origin: "https://evil.example" } });
    expect(elsewhere.status).toBe(403);
    expect(api.calls).toEqual([]);
    const res = await fetch(`${base}/handover`, { method: "POST", headers: { cookie: "s=ana-session", origin: SITE } });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("Started.");
    expect(api.calls).toEqual(["start:ana@example.com"]);
  });
});

describe("numbers (piece F)", () => {
  it("unwraps the CSV the plugin sends inside JSON", async () => {
    const seen: string[] = [];
    const fake = (async (url: string) => {
      seen.push(String(url));
      return new Response(JSON.stringify({ csv: "Date,Owner\r\n2026-10-24,ana@example.com\r\n" }), { status: 200 });
    }) as unknown as typeof fetch;
    const api = paperclipApi({ paperclipUrl: "http://pc", plugin: "p", companyId: "co", paperclipApiKey: null } as never, fake);
    expect(await api.numbersCsv()).toBe("Date,Owner\r\n2026-10-24,ana@example.com\r\n");
    expect(seen).toEqual(["http://pc/api/plugins/p/api/numbers/csv?companyId=co"]);
  });
});
