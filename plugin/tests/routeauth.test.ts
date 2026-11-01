// S1 (docs/design/CURRENT-STATE.md): can one signed-in person use the plugin's
// board routes to get another owner's Approve/Reject links, or act on another
// owner's plan or task?
//
// Paperclip hands every route the caller in `input.actor`
// (@paperclipai/plugin-sdk dist/define-plugin.d.ts, PluginApiRequestInput).
// Each test below has Dee, a teammate signed in with her own Paperclip account,
// ask for or act on Ana's items, and asserts the SAFE outcome: Dee is refused
// (HTTP 403) and nothing of Ana's changes.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import type { Agent, Company, Issue, PluginApiRequestInput, PluginExecutionWorkspaceMetadata } from "@paperclipai/plugin-sdk";
import manifest from "../src/manifest.js";
import plugin from "../src/worker.js";
import { parseSettings } from "../src/config.js";
import { tickPerson } from "../src/handoverrunner.js";
import { createFakeDb } from "./fakedb.js";
import { makeRepoWithWorktree, sh, write } from "./helpers.js";

const CO = "co-1";
const MORNING = new Date("2026-10-22T08:00:00Z");
const config = {
  links: { baseUrl: "http://mail.test", signingSecret: { type: "secret_ref", secretId: "sig" }, expiresMinutes: 60 },
  github: { repo: "acme/app" },
  invites: { expiresMinutes: 30, agentAdapterType: "process", agentAdapterConfig: { command: "pwd" } },
  people: [
    { email: "ana@example.com", agentId: "agent-ana", timezone: "UTC", handoverStartHour: 22, handoverBudgetCapCents: 500 },
    { email: "dee@example.com", agentId: "agent-dee", timezone: "UTC", handoverStartHour: 22, handoverBudgetCapCents: 500 },
  ],
};

type Actor = PluginApiRequestInput["actor"];
/** Today the tests (and, live, the email service's board API key) call as this. */
const EMAIL_SERVICE: Actor = { actorType: "user", actorId: "board" };
/** Dee, signed in to Paperclip in her own browser. */
const DEE: Actor = { actorType: "user", actorId: "user-dee", userId: "user-dee" };

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

/** Ana finished a handover with two Ready tasks; her handback email is waiting to be sent. */
async function setup() {
  const h = createTestHarness({ manifest, config });
  const db = createFakeDb();
  (h.ctx as { db: unknown }).db = db;
  (h.ctx.config as { get: unknown }).get = async () => config;
  const agent = (id: string) => ({ id, companyId: CO, name: id, role: "engineer", status: "idle", permissions: { canCreateAgents: false, canCreateSkills: false } }) as unknown as Agent;
  h.seed({ companies: [{ id: CO, name: "Co" } as unknown as Company], agents: [agent("agent-ana"), agent("agent-dee")] });
  await plugin.definition.setup(h.ctx);
  const worktrees: Record<string, string> = {};
  for (const id of ["t1", "t2"]) {
    const { worktree } = makeRepoWithWorktree();
    const head = commit(worktree, `${id}.txt`);
    worktrees[id] = worktree;
    h.seed({
      executionWorkspaces: [{ id: `ws-${id}`, companyId: CO, projectId: "p", projectWorkspaceId: null, path: worktree, cwd: worktree, repoUrl: null, baseRef: "main", branchName: "task", providerType: "git_worktree", providerMetadata: null } as PluginExecutionWorkspaceMetadata],
      issues: [{ id, companyId: CO, identifier: id.toUpperCase(), title: `Task ${id}`, status: "done", assigneeAgentId: "agent-ana", executionWorkspaceId: `ws-${id}` } as unknown as Issue],
    });
    db.tables.task_events.push({ task_id: id, company_id: CO, owner: "ana@example.com", agent: "agent-ana", task_kind: "task", started_at: "2026-10-21T22:05:00Z", checks_result: "passed", checks_head: head, outcome: null, decision_action_id: null });
  }
  db.tables.handover_runs.push({ company_id: CO, owner: "ana@example.com", agent_id: "agent-ana", handover_key: "2026-10-21", status: "finished", task_ids: JSON.stringify(["t1", "t2"]), current_index: 1, current_attempt: 1 });
  const s = parseSettings(config);
  if (!s.ok) throw new Error(s.errors.join(";"));
  await tickPerson(h.ctx, CO, s.settings, s.settings.people[0]!, MORNING);

  const api = async (actor: Actor, routeKey: string, body: Record<string, unknown> = {}, query: Record<string, string> = {}) =>
    (await plugin.definition.onApiRequest!({ routeKey, method: "POST", path: "", params: {}, query, body, actor, companyId: CO, headers: {} } as PluginApiRequestInput)) as {
      status: number;
      body: Record<string, any>;
    };
  const linkIn = (text: string, kind: "Approve" | "Reject") => text.match(new RegExp(`${kind}: http://mail\\.test/l/(\\S+)`))?.[1];
  const event = (id: string) => db.tables.task_events.find((r) => r.task_id === id)!;
  return { h, db, api, linkIn, event, worktrees };
}

describe("S1: a signed-in teammate calling the plugin's routes directly", () => {
  it("cannot fetch another owner's freshly signed Approve and Reject links", async () => {
    const t = await setup();
    const res = await t.api(DEE, "briefings-pending");
    const leaked = JSON.stringify(res.body).includes("Approve: http://mail.test/l/");
    expect({ status: res.status, leakedAnasLinks: leaked }).toEqual({ status: 403, leakedAnasLinks: false });
  });

  it("cannot approve another owner's task with a link token", async () => {
    const t = await setup();
    const [email] = (await t.api(EMAIL_SERVICE, "briefings-pending")).body.emails;
    const token = t.linkIn(email.text, "Approve")!;
    const res = await t.api(DEE, "link-execute", { token });
    expect(res.status).toBe(403);
    expect(t.event("t1").decision_action_id).toBeNull();
  });

  it("cannot reject another owner's task with a link token", async () => {
    const t = await setup();
    const [email] = (await t.api(EMAIL_SERVICE, "briefings-pending")).body.emails;
    const token = t.linkIn(email.text, "Reject")!;
    const res = await t.api(DEE, "link-execute", { token, reason: "sabotage" });
    expect(res.status).toBe(403);
    expect(t.event("t1").outcome).toBeNull();
  });

  it("cannot mark another owner's waiting pull request as merged (recorded accepted, nothing merged)", async () => {
    const t = await setup();
    const [email] = (await t.api(EMAIL_SERVICE, "briefings-pending")).body.emails;
    const token = t.linkIn(email.text, "Approve")!;
    await t.api(EMAIL_SERVICE, "link-execute", { token });
    await t.api(EMAIL_SERVICE, "link-publish-result", { token, result: "waiting", number: 8, url: "https://github.com/acme/app/pull/8", reason: "review required" });
    const res = await t.api(DEE, "pr-update", { taskId: "t1", state: "merged", mergeSha: "b".repeat(40) });
    expect(res.status).toBe(403);
    expect(t.event("t1").outcome).toBeNull();
  });

  it("cannot start another owner's handover", async () => {
    const t = await setup();
    const res = await t.api(DEE, "handover-start", { email: "ana@example.com" });
    expect(res.status).toBe(403);
  });

  it("cannot read another owner's handover status", async () => {
    const t = await setup();
    const res = await t.api(DEE, "handover-status", {}, { email: "ana@example.com" });
    expect(res.status).toBe(403);
  });

  it("cannot create invites (only the admin, on the server, may invite)", async () => {
    const t = await setup();
    const res = await t.api(DEE, "invite-create", { email: "mallory@example.com", timezone: "UTC", agent: { agentUser: "vt-agent-mal", agentEnvironmentId: "env-mal" } });
    expect(res.status).toBe(403);
    expect(t.db.tables.invites ?? []).toHaveLength(0);
  });

  it("cannot read the email service's queues (waiting pull requests, stuck approvals)", async () => {
    const t = await setup();
    expect((await t.api(DEE, "prs-waiting")).status).toBe(403);
    expect((await t.api(DEE, "links-stuck")).status).toBe(403);
  });

  it("cannot export the whole team's event log", async () => {
    const t = await setup();
    const res = await t.api(DEE, "numbers-csv");
    expect({ status: res.status, containsAna: JSON.stringify(res.body).includes("ana@example.com") }).toEqual({ status: 403, containsAna: false });
  });
});
