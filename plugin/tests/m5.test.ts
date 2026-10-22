import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import type { Agent, Company, Issue, PluginApiRequestInput, PluginExecutionWorkspaceMetadata } from "@paperclipai/plugin-sdk";
import manifest from "../src/manifest.js";
import plugin from "../src/worker.js";
import { parseSettings } from "../src/config.js";
import { previousDate, tickPerson } from "../src/nightrunner.js";
import { baseBranchName } from "../src/links.js";
import { FORBIDDEN_CAPABILITIES } from "../src/routes.js";
import { createFakeDb } from "./fakedb.js";
import { makeRepoWithWorktree, sh, write } from "./helpers.js";

const CO = "co-1";
const MORNING = new Date("2026-10-22T08:00:00Z");
const NEXT_MORNING = new Date("2026-10-23T08:00:00Z");
const baseConfig = {
  links: { baseUrl: "http://mail.test", signingSecret: { type: "secret_ref", secretId: "sig" }, expiresMinutes: 60 },
  github: { repo: "acme/app" },
  invites: { expiresMinutes: 30, agentAdapterType: "process", agentAdapterConfig: { command: "pwd" } },
  people: [{ email: "ana@example.com", agentId: "agent-ana", timezone: "UTC", nightStartHour: 22, nightBudgetCapCents: 500 }],
};

function settingsOf(config: unknown) {
  const r = parseSettings(config);
  if (!r.ok) throw new Error(r.errors.join(";"));
  return r.settings;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(MORNING.getTime() + 60_000));
});
afterEach(() => vi.useRealTimers());

function commit(dir: string, file: string): string {
  write(dir, file, `${file}\n`);
  sh(dir, "add", ".");
  sh(dir, "-c", "user.email=t@example.com", "-c", "user.name=T", "commit", "-q", "-m", `edit ${file}`);
  return sh(dir, "rev-parse", "HEAD").trim();
}

/** Ana finished a night with two Ready tasks; GitHub mode is on. */
async function setup(config: Record<string, unknown> = baseConfig) {
  let current = config;
  const h = createTestHarness({ manifest, config });
  const db = createFakeDb();
  (h.ctx as { db: unknown }).db = db;
  // The email service saves new people through Paperclip's config API; let tests do the same.
  (h.ctx.config as { get: unknown }).get = async () => current;
  const setConfig = (c: Record<string, unknown>) => (current = c);
  const agent = { id: "agent-ana", companyId: CO, name: "a", role: "engineer", status: "idle", permissions: { canCreateAgents: false, canCreateSkills: false } } as unknown as Agent;
  h.seed({ companies: [{ id: CO, name: "Co" } as unknown as Company], agents: [agent] });
  await plugin.definition.setup(h.ctx);
  const heads: Record<string, string> = {};
  const worktrees: Record<string, string> = {};
  for (const id of ["t1", "t2"]) {
    const { worktree } = makeRepoWithWorktree();
    heads[id] = commit(worktree, `${id}.txt`);
    worktrees[id] = worktree;
    h.seed({
      executionWorkspaces: [{ id: `ws-${id}`, companyId: CO, projectId: "p", projectWorkspaceId: null, path: worktree, cwd: worktree, repoUrl: null, baseRef: "main", branchName: "task", providerType: "git_worktree", providerMetadata: null } as PluginExecutionWorkspaceMetadata],
      issues: [{ id, companyId: CO, identifier: id.toUpperCase(), title: `Task ${id}`, status: "done", assigneeAgentId: "agent-ana", executionWorkspaceId: `ws-${id}` } as unknown as Issue],
    });
    db.tables.task_events.push({ task_id: id, company_id: CO, owner: "ana@example.com", agent: "agent-ana", task_kind: "task", started_at: "2026-10-21T22:05:00Z", checks_result: "passed", checks_head: heads[id], outcome: null, decision_action_id: null });
  }
  db.tables.night_runs.push({ company_id: CO, owner: "ana@example.com", agent_id: "agent-ana", night_date: "2026-10-21", status: "finished", task_ids: JSON.stringify(["t1", "t2"]), current_index: 1, current_attempt: 1 });
  const tick = (now: Date) => tickPerson(h.ctx, CO, settingsOf(current), settingsOf(current).people[0]!, now);
  await tick(MORNING);

  const api = async (routeKey: string, body: Record<string, unknown> = {}) =>
    (await plugin.definition.onApiRequest!({ routeKey, method: "POST", path: "", params: {}, query: {}, body, actor: { actorType: "user", actorId: "board" }, companyId: CO, headers: {} } as PluginApiRequestInput)) as {
      status: number;
      body: Record<string, any>;
    };
  const pending = async () => (await api("briefings-pending")).body.emails as Array<{ briefingId: string; to: string; subject: string; text: string }>;
  const linkIn = (text: string, kind: "Approve" | "Reject", n = 0) => [...text.matchAll(new RegExp(`${kind}: http://mail\\.test/l/(\\S+)`, "g"))][n]?.[1];
  const event = (id: string) => db.tables.task_events.find((r) => r.task_id === id)!;
  return { h, db, api, pending, linkIn, event, heads, worktrees, tick, setConfig };
}

describe("Approve in GitHub mode", () => {
  it("returns exactly what to publish, and merges nothing locally", async () => {
    const t = await setup();
    const [email] = await t.pending();
    const token = t.linkIn(email!.text, "Approve")!;
    expect((await t.api("link-preview", { token })).body).toMatchObject({ ok: true, github: "acme/app" });
    const res = await t.api("link-execute", { token });
    expect(res.body).toMatchObject({
      ok: true,
      status: "publish",
      publish: { repo: "acme/app", branch: "task", baseBranch: "main", expectedHead: t.heads.t1, worktree: t.worktrees.t1 },
    });
    // The decision is held while GitHub works: a second click and the Reject link do nothing.
    expect((await t.api("link-execute", { token })).body.status).toBe("already-used");
    expect((await t.api("link-execute", { token: t.linkIn(email!.text, "Reject")!, reason: "no" })).body.status).toBe("refused");
    expect(sh(t.worktrees.t1, "log", "--merges", "--oneline", "main").trim()).toBe("");
  });

  it("refuses to publish a branch that changed after the email", async () => {
    const t = await setup();
    const [email] = await t.pending();
    commit(t.worktrees.t1, "late.txt");
    const res = await t.api("link-execute", { token: t.linkIn(email!.text, "Approve")! });
    expect(res.body).toMatchObject({ ok: false, status: "refused" });
    expect(t.event("t1").decision_action_id).toBeNull();
  });

  it("merged on GitHub: the task is accepted and the ticket done", async () => {
    const t = await setup();
    const token = t.linkIn((await t.pending())[0]!.text, "Approve")!;
    await t.api("link-execute", { token });
    const res = await t.api("link-publish-result", { token, result: "merged", number: 7, url: "https://github.com/acme/app/pull/7", mergeSha: "a".repeat(40) });
    expect(res.body).toMatchObject({ ok: true, status: "merged" });
    expect(t.event("t1").outcome).toBe("accepted");
    expect((await t.h.ctx.issues.get("t1", CO))?.status).toBe("done");
    // Reporting twice changes nothing.
    expect((await t.api("link-publish-result", { token, result: "merged", number: 7, url: "https://x/7" })).body.status).toBe("refused");
  });

  it("blocked by branch protection: waiting for review, then listed in the next email, then merged by a reviewer", async () => {
    const t = await setup();
    const token = t.linkIn((await t.pending())[0]!.text, "Approve")!;
    await t.api("link-execute", { token });
    const res = await t.api("link-publish-result", { token, result: "waiting", number: 8, url: "https://github.com/acme/app/pull/8", reason: "At least 1 approving review is required" });
    expect(res.body).toMatchObject({ ok: true, status: "waiting" });
    expect(res.body.message).toContain("waiting for review");
    expect(t.event("t1").outcome).toBeNull();
    expect((await t.h.ctx.issues.get("t1", CO))?.status).toBe("in_review");

    // The next morning's email (no night ran) lists it under "Waiting for review" without links,
    // and brings back the undecided t2 with fresh links.
    t.db.tables.briefings.forEach((b) => (b.status = "sent"));
    vi.setSystemTime(NEXT_MORNING);
    await t.tick(NEXT_MORNING);
    const [next] = await t.pending();
    expect(next!.subject).toBe("Your night of 2026-10-22: 1 ready, 0 blocked, 0 failed, 1 waiting for review");
    expect(next!.text).toContain("WAITING FOR REVIEW (1)");
    expect(next!.text).toContain("Pull request: https://github.com/acme/app/pull/8");
    expect(next!.text.match(/^ {2}Approve: /gm)).toHaveLength(1); // only t2

    expect((await t.api("prs-waiting")).body).toEqual({ repo: "acme/app", pullRequests: [{ taskId: "t1", number: 8, url: "https://github.com/acme/app/pull/8", headSha: t.heads.t1 }] });
    expect((await t.api("pr-update", { taskId: "t1", state: "merged", mergeSha: "b".repeat(40) })).body).toEqual({ ok: true, message: "merged" });
    expect(t.event("t1").outcome).toBe("accepted");
    expect((await t.api("pr-update", { taskId: "t1", state: "closed" })).body.ok).toBe(false);
    expect((await t.api("prs-waiting")).body.pullRequests).toEqual([]);
  });

  it("a pull request closed without merging counts as rejected", async () => {
    const t = await setup();
    const token = t.linkIn((await t.pending())[0]!.text, "Approve")!;
    await t.api("link-execute", { token });
    await t.api("link-publish-result", { token, result: "waiting", number: 9, url: "https://github.com/acme/app/pull/9" });
    await t.api("pr-update", { taskId: "t1", state: "closed" });
    expect(t.event("t1")).toMatchObject({ outcome: "rejected", reject_reason: "pull request closed on GitHub without merging" });
  });

  it("a GitHub failure releases the task: it comes back next morning with fresh links", async () => {
    const t = await setup();
    const first = (await t.pending())[0]!;
    const token = t.linkIn(first.text, "Approve")!;
    await t.api("link-execute", { token });
    const res = await t.api("link-publish-result", { token, result: "failed", message: "GitHub answered 403" });
    expect(res.body).toMatchObject({ ok: false, status: "refused", message: "Not merged: GitHub answered 403." });
    expect(t.event("t1").decision_action_id).toBeNull();
    t.db.tables.briefings.forEach((b) => (b.status = "sent"));
    vi.setSystemTime(NEXT_MORNING);
    await t.tick(NEXT_MORNING);
    const [next] = await t.pending();
    const fresh = t.linkIn(next!.text, "Approve")!;
    expect(fresh).not.toBe(token);
    expect(next!.text).toContain("From an earlier email; still waiting for your decision.");
    expect((await t.api("link-execute", { token: fresh })).body.status).toBe("publish");
  });
});

describe("undecided tasks carry over", () => {
  it("an expired, undecided task reappears in the next morning's email with fresh links; decided ones do not", async () => {
    const t = await setup({ ...baseConfig, github: undefined });
    const first = (await t.pending())[0]!;
    await t.api("link-execute", { token: t.linkIn(first.text, "Reject")!, reason: "not needed" }); // t1 decided
    t.db.tables.briefings.forEach((b) => (b.status = "sent"));
    vi.setSystemTime(NEXT_MORNING);
    // Yesterday's links are expired now.
    expect((await t.api("link-execute", { token: t.linkIn(first.text, "Approve", 1)! })).body.status).toBe("expired");
    await t.tick(NEXT_MORNING);
    const [next] = await t.pending();
    expect(next!.text).toContain("T2 Task t2");
    expect(next!.text).not.toContain("T1 Task t1");
    const res = await t.api("link-execute", { token: t.linkIn(next!.text, "Approve")! });
    expect(res.body.status).toBe("merged");
    // Built once: another tick the same morning makes no second email.
    await t.tick(new Date(NEXT_MORNING.getTime() + 600_000));
    expect(t.db.tables.briefings).toHaveLength(2);
  });

  it("nothing undecided means no email on a morning without a night", async () => {
    const t = await setup({ ...baseConfig, github: undefined });
    const first = (await t.pending())[0]!;
    await t.api("link-execute", { token: t.linkIn(first.text, "Approve")! });
    await t.api("link-execute", { token: t.linkIn(first.text, "Reject", 1)!, reason: "no" });
    vi.setSystemTime(NEXT_MORNING);
    await t.tick(NEXT_MORNING);
    expect(t.db.tables.briefings).toHaveLength(1);
  });

  it("previousDate crosses month and year ends", () => {
    expect(previousDate("2026-11-01")).toBe("2026-10-31");
    expect(previousDate("2027-01-01")).toBe("2026-12-31");
    expect(baseBranchName("refs/heads/main")).toBe("main");
    expect(baseBranchName("origin/develop")).toBe("develop");
  });
});

describe("invite links", () => {
  async function invite(t: Awaited<ReturnType<typeof setup>>, email = "cy@example.com") {
    const res = await t.api("invite-create", { email, timezone: "Europe/Berlin" });
    expect(res.status).toBe(201);
    return { ...res.body, token: (res.body.url as string).split("/join/")[1]! };
  }

  it("one link: preview changes nothing, the first claim wins, a used link is refused", async () => {
    const t = await setup();
    const inv = await invite(t);
    expect(inv.url).toMatch(/^http:\/\/mail\.test\/join\//);
    expect((await t.api("invite-preview", { token: inv.token })).body).toMatchObject({ ok: true, email: "cy@example.com", timezone: "Europe/Berlin" });
    const [a, b] = await Promise.all([t.api("invite-claim", { token: inv.token }), t.api("invite-claim", { token: inv.token })]);
    expect([a.body.status, b.body.status].sort()).toEqual(["already-used", "claimed"]);
    const plan = (a.body.status === "claimed" ? a : b).body.plan;
    expect(plan).toMatchObject({ email: "cy@example.com", timezone: "Europe/Berlin", defaults: { agentAdapterType: "process", nightBudgetCapCents: 300, maxTasksPerNight: 3 } });
    expect((await t.api("invite-preview", { token: inv.token })).body.status).toBe("already-used");
  });

  it("finishing only counts when the settings really bind the new person to the new agent", async () => {
    const t = await setup();
    const inv = await invite(t);
    const { plan } = (await t.api("invite-claim", { token: inv.token })).body;
    expect((await t.api("invite-finish", { inviteId: plan.inviteId, ok: true, agentId: "agent-cy" })).body).toEqual({ ok: false, message: "the settings row for this person was not saved" });

    const inv2 = await invite(t, "dee@example.com");
    const plan2 = (await t.api("invite-claim", { token: inv2.token })).body.plan;
    t.setConfig({ ...baseConfig, people: [...baseConfig.people, { email: "dee@example.com", agentId: "agent-dee", timezone: "UTC", nightStartHour: 22, nightBudgetCapCents: 300 }] });
    expect((await t.api("invite-finish", { inviteId: plan2.inviteId, ok: true, agentId: "agent-dee", userId: "u1" })).body).toEqual({ ok: true, message: "joined" });
    expect(t.db.tables.invites.find((r) => r.id === plan2.inviteId)).toMatchObject({ state: "done", agent_id: "agent-dee" });
    // Someone already on the team cannot be invited again.
    expect((await t.api("invite-create", { email: "dee@example.com" })).body).toEqual({ ok: false, message: "this person is already on the team" });
  });

  it("an expired, forged or approve-link token is refused", async () => {
    const t = await setup();
    const inv = await invite(t);
    const forged = inv.token.slice(0, -2) + (inv.token.endsWith("AA") ? "BB" : "AA");
    expect((await t.api("invite-claim", { token: forged })).body.status).toBe("invalid");
    const approve = t.linkIn((await t.pending())[0]!.text, "Approve")!;
    expect((await t.api("invite-claim", { token: approve })).body.status).toBe("invalid");
    vi.setSystemTime(new Date(MORNING.getTime() + 31 * 60_000)); // invites live 30 minutes here
    expect((await t.api("invite-claim", { token: inv.token })).body.status).toBe("expired");
    expect(t.db.tables.invites[0]!.state).toBe("new");
  });

  it("needs links set up, a valid email and timezone", async () => {
    const t = await setup();
    expect((await t.api("invite-create", { email: "nope" })).body.ok).toBe(false);
    expect((await t.api("invite-create", { email: "z@example.com", timezone: "Mars/Base" })).body.ok).toBe(false);
    t.setConfig({ ...baseConfig, links: undefined });
    expect((await t.api("invite-create", { email: "z@example.com" })).body.message).toContain("links");
  });
});

describe("the GitHub token never enters Paperclip", () => {
  it("plugin settings have no place for a token: any extra GitHub field is refused without echoing it", () => {
    const leaked = ["gh", "p_"].join("") + "Z".repeat(36);
    const r = parseSettings({ ...baseConfig, github: { repo: "acme/app", token: leaked } });
    expect(r.ok).toBe(false);
    expect(JSON.stringify(r)).not.toContain(leaked);
    expect((manifest.instanceConfigSchema as any).properties.github.additionalProperties).toBe(false);
  });

  it("the plugin cannot make web requests at all, so it could not use a token even if it had one", () => {
    expect(FORBIDDEN_CAPABILITIES).toContain("http.outbound");
    expect(manifest.capabilities).not.toContain("http.outbound");
  });

  it("every route that touches publishing is board-only (agents cannot call it)", () => {
    for (const r of manifest.apiRoutes ?? []) expect(r.auth).toBe("board");
  });
});
