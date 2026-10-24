import { execFileSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import type { Agent, Company, Issue, PluginApiRequestInput, PluginExecutionWorkspaceMetadata } from "@paperclipai/plugin-sdk";
import manifest from "../src/manifest.js";
import plugin from "../src/worker.js";
import { parseSettings } from "../src/config.js";
import { tickPerson } from "../src/nightrunner.js";
import { executeLink } from "../src/links.js";
import { signLink, peekClaims, verifyLink } from "../src/tokens.js";
import { createFakeDb } from "./fakedb.js";
import { makeRepoWithWorktree, sh, write } from "./helpers.js";

const CO = "co-1";
const MORNING = new Date("2026-10-22T08:00:00Z");
// Link routes read the real clock; pin it a minute after the briefing so links
// with a 60-minute lifetime are valid whenever the tests run.
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(MORNING.getTime() + 60_000));
});
afterEach(() => vi.useRealTimers());
const config = {
  links: { baseUrl: "http://mail.test", signingSecret: { type: "secret_ref", secretId: "sig" }, expiresMinutes: 60 },
  people: [
    { email: "ana@example.com", agentId: "agent-ana", timezone: "UTC", nightStartHour: 22, nightBudgetCapCents: 500 },
    { email: "bo@example.com", agentId: "agent-bo", timezone: "UTC", nightStartHour: 22, nightBudgetCapCents: 500 },
  ],
};
const settings = (() => {
  const r = parseSettings(config);
  if (!r.ok) throw new Error(r.errors.join(";"));
  return r.settings;
})();

function commit(dir: string, file: string, content: string): string {
  write(dir, file, content);
  sh(dir, "add", ".");
  sh(dir, "-c", "user.email=t@example.com", "-c", "user.name=T", "commit", "-q", "-m", `edit ${file}`);
  return sh(dir, "rev-parse", "HEAD").trim();
}

/** A finished night for Ana with two Ready tasks, and one for Bo with one. */
async function setup() {
  const h = createTestHarness({ manifest, config });
  const db = createFakeDb();
  (h.ctx as { db: unknown }).db = db;
  const agent = (id: string) => ({ id, companyId: CO, name: id, role: "engineer", status: "idle", permissions: { canCreateAgents: false, canCreateSkills: false } }) as unknown as Agent;
  h.seed({ companies: [{ id: CO, name: "Co" } as unknown as Company], agents: [agent("agent-ana"), agent("agent-bo")] });
  await plugin.definition.setup(h.ctx);

  const repos: Record<string, { repo: string; worktree: string; head: string }> = {};
  const task = (id: string, owner: string, agentId: string) => {
    const { repo, worktree } = makeRepoWithWorktree();
    const head = commit(worktree, `${id}.txt`, `${id}\n`);
    repos[id] = { repo, worktree, head };
    h.seed({
      executionWorkspaces: [{ id: `ws-${id}`, companyId: CO, projectId: "p", projectWorkspaceId: null, path: worktree, cwd: worktree, repoUrl: null, baseRef: "main", branchName: "task", providerType: "git_worktree", providerMetadata: null } as PluginExecutionWorkspaceMetadata],
      issues: [{ id, companyId: CO, identifier: id.toUpperCase(), title: `Task ${id}`, status: "done", assigneeAgentId: agentId, executionWorkspaceId: `ws-${id}` } as unknown as Issue],
    });
    db.tables.task_events.push({ task_id: id, company_id: CO, owner, agent: agentId, task_kind: "task", started_at: "2026-10-21T22:05:00Z", finished_at: "2026-10-21T23:00:00Z", checks_result: "passed", checks_head: head, outcome: null, decision_action_id: null });
  };
  task("t1", "ana@example.com", "agent-ana");
  task("t2", "ana@example.com", "agent-ana");
  task("t3", "bo@example.com", "agent-bo");
  const night = (owner: string, agentId: string, taskIds: string[]) =>
    db.tables.night_runs.push({ company_id: CO, owner, agent_id: agentId, night_date: "2026-10-21", status: "finished", task_ids: JSON.stringify(taskIds), current_index: taskIds.length - 1, current_attempt: 1 });
  night("ana@example.com", "agent-ana", ["t1", "t2"]);
  night("bo@example.com", "agent-bo", ["t3"]);

  for (const person of settings.people) await tickPerson(h.ctx, CO, settings, person, MORNING);

  const api = async (routeKey: string, body: Record<string, unknown> = {}, params: Record<string, string> = {}) =>
    (await plugin.definition.onApiRequest!({ routeKey, method: "POST", path: "", params, query: {}, body, actor: { actorType: "user", actorId: "board" }, companyId: CO, headers: {} } as PluginApiRequestInput)) as {
      status: number;
      body: Record<string, any>;
    };
  const emails = (await api("briefings-pending")).body.emails as Array<{ briefingId: string; to: string; text: string }>;
  const linkFor = (to: string, kind: "Approve" | "Reject", n = 0) =>
    [...emails.find((e) => e.to === to)!.text.matchAll(new RegExp(`${kind}: http://mail\\.test/l/(\\S+)`, "g"))][n]![1]!;
  const merges = (id: string) =>
    execFileSync("git", ["log", "--merges", "--format=%P", "main"], { cwd: repos[id]!.repo, encoding: "utf8" }).split("\n").filter((l) => l.includes(repos[id]!.head)).length;
  return { h, db, api, emails, linkFor, merges, repos };
}

describe("morning briefing", () => {
  it("builds one email per person after the night, with Approve and Reject per Ready task", async () => {
    const { emails, db } = await setup();
    expect(emails.map((e) => e.to).sort()).toEqual(["ana@example.com", "bo@example.com"]);
    expect(emails.find((e) => e.to === "ana@example.com")!.text).toContain("READY (2)");
    expect(db.tables.link_actions).toHaveLength(6);
  });

  it("is built once, and marked sent stops it being sent again", async () => {
    const t = await setup();
    for (const p of settings.people) await tickPerson(t.h.ctx, CO, settings, p, new Date(MORNING.getTime() + 600_000));
    expect(t.db.tables.briefings).toHaveLength(2);
    for (const e of t.emails) await t.api("briefing-sent", {}, { briefingId: e.briefingId });
    expect((await t.api("briefings-pending")).body.emails).toEqual([]);
  });
});

describe("approve link", () => {
  it("opening (preview) changes nothing", async () => {
    const t = await setup();
    const res = await t.api("link-preview", { token: t.linkFor("ana@example.com", "Approve") });
    expect(res.body).toMatchObject({ ok: true, kind: "approve", task: { identifier: "T1" } });
    expect(t.merges("t1")).toBe(0);
  });

  it("a double click merges exactly once", async () => {
    const t = await setup();
    const token = t.linkFor("ana@example.com", "Approve");
    const [a, b] = await Promise.all([t.api("link-execute", { token }), t.api("link-execute", { token })]);
    expect([a.body.status, b.body.status].sort()).toEqual(["already-used", "merged"]);
    expect(t.merges("t1")).toBe(1);
    expect((await t.api("link-execute", { token })).body.status).toBe("already-used");
    expect(t.db.tables.task_events.find((r) => r.task_id === "t1")!.outcome).toBe("accepted");
    expect((await t.h.ctx.issues.get("t1", CO))?.status).toBe("done");
  });

  it("refuses when the branch changed after the email, and nothing is merged", async () => {
    const t = await setup();
    commit(t.repos.t2!.worktree, "late.txt", "late change\n");
    const res = await t.api("link-execute", { token: t.linkFor("ana@example.com", "Approve", 1) });
    expect(res.body).toMatchObject({ ok: false, status: "refused" });
    expect(res.body.message).toContain("branch changed");
    expect(t.merges("t2")).toBe(0);
    expect(t.db.tables.task_events.find((r) => r.task_id === "t2")!.outcome).toBeNull();
  });

  it("refuses forged and expired links", async () => {
    const t = await setup();
    const token = t.linkFor("ana@example.com", "Approve");
    const forged = token.slice(0, -2) + (token.endsWith("AA") ? "BB" : "AA");
    expect((await t.api("link-execute", { token: forged })).body.status).toBe("invalid");
    const later = new Date(MORNING.getTime() + 2 * 3600_000); // links were made at MORNING, valid 60 min
    expect(await executeLink(t.h.ctx, settings, CO, token, null, later)).toMatchObject({ ok: false, status: "expired" });
    expect(t.merges("t1")).toBe(0);
  });

  it("refuses another person's link for the owner's task, even if correctly signed", async () => {
    const t = await setup();
    const bos = peekClaims(t.linkFor("bo@example.com", "Approve"))!;
    const anas = peekClaims(t.linkFor("ana@example.com", "Approve"))!;
    // Someone holding the signing key builds a link with Bo's action but Ana's task, and the reverse.
    // The SDK test kit resolves every secret ref to `resolved:${ref}`.
    const secret = `resolved:${{ type: "secret_ref", secretId: "sig" }}`;
    const mixed = [
      signLink({ ...(bos as any), t: anas.t }, secret),
      signLink({ ...(anas as any), o: "bo@example.com" }, secret),
    ];
    for (const token of mixed) {
      expect(verifyLink(token, secret, MORNING).ok).toBe(true); // the signature itself is valid
      expect((await t.api("link-execute", { token })).body.status).toBe("invalid");
    }
    expect(t.merges("t1")).toBe(0);
  });
});

describe("reject link", () => {
  it("asks for a one-line reason without using up the link, then stores it", async () => {
    const t = await setup();
    const token = t.linkFor("ana@example.com", "Reject");
    expect((await t.api("link-execute", { token })).body.status).toBe("needs-reason");
    expect((await t.api("link-execute", { token, reason: "x".repeat(201) })).body.status).toBe("needs-reason");
    const res = await t.api("link-execute", { token, reason: "  Wrong approach,\n use the API  " });
    expect(res.body.status).toBe("rejected");
    const ev = t.db.tables.task_events.find((r) => r.task_id === "t1")!;
    expect(ev).toMatchObject({ outcome: "rejected", reject_reason: "Wrong approach, use the API" });
    expect((await t.api("link-execute", { token, reason: "again" })).body.status).toBe("already-used");
  });

  it("after a reject, the approve link for the same task does nothing", async () => {
    const t = await setup();
    await t.api("link-execute", { token: t.linkFor("ana@example.com", "Reject"), reason: "no" });
    const res = await t.api("link-execute", { token: t.linkFor("ana@example.com", "Approve") });
    expect(res.body.status).toBe("refused");
    expect(t.merges("t1")).toBe(0);
  });

  it("can reject a task the night routine blocked or failed (but never approve it)", async () => {
    const t = await setup();
    t.db.tables.task_events.find((r) => r.task_id === "t2")!.outcome = "blocked";
    const res = await t.api("link-execute", { token: t.linkFor("ana@example.com", "Reject", 1), reason: "not worth it" });
    expect(res.body.status).toBe("rejected");
    expect(t.db.tables.task_events.find((r) => r.task_id === "t2")).toMatchObject({ outcome: "rejected", reject_reason: "not worth it" });
  });

  it("an approve link refuses a task that is no longer undecided", async () => {
    const t = await setup();
    t.db.tables.task_events.find((r) => r.task_id === "t1")!.outcome = "failed";
    expect((await t.api("link-execute", { token: t.linkFor("ana@example.com", "Approve") })).body.status).toBe("refused");
    expect(t.merges("t1")).toBe(0);
  });
});
