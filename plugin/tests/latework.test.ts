/**
 * B4: work that finishes just after the handover window ends. It used to be
 * marked blocked for good, so the owner could only reject it. Now the handback
 * waits a little for the task the window cut off, and a blocked task that is
 * genuinely Ready (done, clean, checks passed on the branch head) gets a normal
 * Approve link.
 */
import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import type { Agent, Company, Issue, PluginApiRequestInput, PluginExecutionWorkspaceMetadata } from "@paperclipai/plugin-sdk";
import manifest from "../src/manifest.js";
import plugin from "../src/worker.js";
import { parseSettings } from "../src/config.js";
import { tickPerson } from "../src/handoverrunner.js";
import { createFakeDb } from "./fakedb.js";
import { makeRepoWithWorktree, sh, write } from "./helpers.js";

const CO = "co-1";
const START = new Date("2026-10-21T22:00:00Z");
const END = new Date("2026-10-22T06:00:00Z"); // 8-hour window
const at = (minutesAfterEnd: number) => new Date(END.getTime() + minutesAfterEnd * 60_000);

const config = {
  links: { baseUrl: "http://mail.test", signingSecret: { type: "secret_ref", secretId: "sig" }, expiresMinutes: 600 },
  night: { stepTimeoutMinutes: 60, maxRetries: 1 },
  people: [{ email: "ana@example.com", agentId: "agent-ana", timezone: "UTC", handoverStartHour: 22, handoverBudgetCapCents: 500 }],
};
const settings = (() => {
  const r = parseSettings(config);
  if (!r.ok) throw new Error(r.errors.join(";"));
  return r.settings;
})();
const ana = settings.people[0]!;

afterEach(() => vi.useRealTimers());

/** Ana's handover is running task t1 (in progress, nothing committed or checked yet) when the window ends. */
async function setup() {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(at(-30));
  const h = createTestHarness({ manifest, config });
  const db = createFakeDb();
  (h.ctx as { db: unknown }).db = db;
  h.seed({
    companies: [{ id: CO, name: "Co" } as unknown as Company],
    agents: [{ id: "agent-ana", companyId: CO, name: "a", role: "engineer", status: "running", permissions: { canCreateAgents: false, canCreateSkills: false } } as unknown as Agent],
  });
  await plugin.definition.setup(h.ctx);
  const { repo, worktree } = makeRepoWithWorktree();
  h.seed({
    executionWorkspaces: [{ id: "ws-t1", companyId: CO, projectId: "p", projectWorkspaceId: null, path: worktree, cwd: worktree, repoUrl: null, baseRef: "main", branchName: "task", providerType: "git_worktree", providerMetadata: null } as PluginExecutionWorkspaceMetadata],
    issues: [{ id: "t1", companyId: CO, identifier: "T1", title: "Fix login", status: "in_progress", assigneeAgentId: "agent-ana", executionWorkspaceId: "ws-t1" } as unknown as Issue],
  });
  db.tables.task_events.push({ task_id: "t1", company_id: CO, owner: ana.email, agent: "agent-ana", task_kind: "task", started_at: START.toISOString(), outcome: null, decision_action_id: null });
  db.tables.handover_runs.push({
    company_id: CO, owner: ana.email, agent_id: "agent-ana", handover_key: "2026-10-21", kind: "scheduled",
    starts_at: START.toISOString(), ends_at: END.toISOString(), status: "running", task_ids: JSON.stringify(["t1"]),
    current_index: 0, current_attempt: 1, step_started_at: at(-30).toISOString(),
  });

  const tick = async (now: Date) => {
    vi.setSystemTime(now);
    return tickPerson(h.ctx, CO, settings, ana, now);
  };
  /** The agent finishes: commits, runs the checks gate (passed on that commit), marks the ticket done. */
  const agentFinishes = async () => {
    write(worktree, "login.ts", "fixed\n");
    sh(worktree, "add", ".");
    sh(worktree, "-c", "user.email=t@example.com", "-c", "user.name=T", "commit", "-q", "-m", "fix login");
    const head = sh(worktree, "rev-parse", "HEAD").trim();
    Object.assign(db.tables.task_events[0]!, { checks_result: "passed", checks_head: head });
    await h.ctx.issues.update("t1", { status: "done" }, CO);
    return head;
  };
  const api = async (routeKey: string, body: Record<string, unknown> = {}) =>
    (await plugin.definition.onApiRequest!({ routeKey, method: "POST", path: "", params: {}, query: {}, body, actor: { actorType: "user", actorId: "board" }, companyId: CO, headers: {} } as PluginApiRequestInput)) as {
      status: number;
      body: Record<string, any>;
    };
  const emailText = async () => ((await api("briefings-pending")).body.emails as Array<{ text: string }>)[0]?.text ?? null;
  const merged = (head: string) => execFileSync("git", ["log", "--format=%P", "main"], { cwd: repo, encoding: "utf8" }).includes(head);
  const event = () => db.tables.task_events[0]!;
  return { h, db, tick, agentFinishes, api, emailText, merged, event };
}

describe("work that finishes just after the handover ends (B4)", () => {
  it("the handback waits for it, shows it Ready, and Approve merges it normally", async () => {
    const t = await setup();
    await t.tick(at(1)); // the window has ended with t1 still running
    expect(t.db.tables.handover_runs[0]!.status).toBe("finished");
    expect(t.event().outcome).toBe("blocked");
    // The plugin cannot stop the run, so it does not flip the ticket to blocked under the agent.
    expect((await t.h.ctx.issues.get("t1", CO))?.status).toBe("in_progress");
    expect(t.db.tables.briefings).toHaveLength(0); // waiting for the cut-off task

    const head = await t.agentFinishes();
    await t.tick(at(15));
    const text = await t.emailText();
    expect(text).toContain("READY (1)");
    const token = /Approve: http:\/\/mail\.test\/l\/(\S+)/.exec(text!)![1]!;
    const res = await t.api("link-execute", { token });
    expect(res.body.status).toBe("merged");
    expect(t.merged(head)).toBe(true);
    expect(t.event().outcome).toBe("accepted");
  });

  it("if it never finishes, the handback comes after one step time-out, blocked, with Reject only", async () => {
    const t = await setup();
    await t.tick(at(1));
    await t.tick(at(30));
    expect(t.db.tables.briefings).toHaveLength(0);
    await t.tick(at(61));
    const text = await t.emailText();
    expect(text).toContain("BLOCKED (1)");
    expect(text).not.toContain("Approve: ");
    expect(text).toContain("Reject: ");
  });

  it("finishing after the handback was built: the next handback offers Approve", async () => {
    const t = await setup();
    await t.tick(at(1));
    await t.tick(at(61)); // gave up waiting: blocked
    expect(await t.emailText()).toContain("BLOCKED (1)");
    for (const b of t.db.tables.briefings) b.status = "sent";

    const head = await t.agentFinishes();
    await t.tick(new Date("2026-10-23T08:00:00Z")); // the next morning: undecided tasks come back
    const text = await t.emailText();
    expect(text).toContain("READY (1)");
    const token = /Approve: http:\/\/mail\.test\/l\/(\S+)/.exec(text!)![1]!;
    expect((await t.api("link-execute", { token })).body.status).toBe("merged");
    expect(t.merged(head)).toBe(true);
  });

  it("blocked work that is not Ready stays Reject-only (checks failed)", async () => {
    const t = await setup();
    await t.tick(at(1));
    await t.agentFinishes();
    t.event().checks_result = "failed";
    await t.tick(at(15));
    const text = await t.emailText();
    expect(text).toContain("BLOCKED (1)");
    expect(text).not.toContain("Approve: ");
    expect(t.event().outcome).toBe("blocked");
  });

  it("a task failed by its time-outs (the agent was just slow) is approvable when it lands later (B5)", async () => {
    const t = await setup();
    // Last allowed attempt, past its time limit, window still open.
    Object.assign(t.db.tables.handover_runs[0]!, { current_attempt: 2, step_started_at: at(-200).toISOString() });
    await t.tick(at(-120));
    expect(t.event().outcome).toBe("failed");
    await t.tick(at(1)); // a scheduled handover's handback comes after its window
    expect(await t.emailText()).toContain("FAILED (1)");
    for (const b of t.db.tables.briefings) b.status = "sent";

    const head = await t.agentFinishes(); // the slow run was still going, and finishes
    await t.tick(new Date("2026-10-23T08:00:00Z"));
    const text = await t.emailText();
    expect(text).toContain("READY (1)");
    const token = /Approve: http:\/\/mail\.test\/l\/(\S+)/.exec(text!)![1]!;
    expect((await t.api("link-execute", { token })).body.status).toBe("merged");
    expect(t.merged(head)).toBe(true);
  });
});
