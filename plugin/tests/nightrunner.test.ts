import { describe, expect, it } from "vitest";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import type { Agent, Company, Issue, PluginAccessMember } from "@paperclipai/plugin-sdk";
import manifest from "../src/manifest.js";
import plugin from "../src/worker.js";
import { parseSettings } from "../src/config.js";
import { tickPerson } from "../src/nightrunner.js";
import { TOOL_PROPOSE } from "../src/tools.js";
import { NIGHT_TASK_ORIGIN, PLAN_ORIGIN } from "../src/ids.js";
import { createFakeDb } from "./fakedb.js";

const CO = "co-1";
// Ana's night starts at 22:00 UTC; the evening plan opens at 20:00.
const EVENING = new Date("2026-10-21T20:30:00Z");
const NIGHT = new Date("2026-10-21T22:05:00Z");
const config = {
  night: { projectId: "proj-1", stepTimeoutMinutes: 60, maxRetries: 1 },
  people: [
    { email: "ana@example.com", agentId: "agent-ana", timezone: "UTC", nightStartHour: 22, nightBudgetCapCents: 500, maxTasksPerNight: 2 },
    { email: "bo@example.com", agentId: "agent-bo", timezone: "UTC", nightStartHour: 22, nightBudgetCapCents: 500 },
  ],
};
const settings = (() => {
  const r = parseSettings(config);
  if (!r.ok) throw new Error(r.errors.join(";"));
  return r.settings;
})();
const ana = settings.people[0]!;

async function setup() {
  const capabilities = [...manifest.capabilities, "issue.interactions.respond" as const];
  const h = createTestHarness({ manifest, capabilities, config });
  const db = createFakeDb();
  (h.ctx as { db: unknown }).db = db;
  const agent = (id: string) => ({ id, companyId: CO, name: id, role: "engineer", status: "idle", permissions: { canCreateAgents: false, canCreateSkills: false } }) as unknown as Agent;
  h.seed({
    companies: [{ id: CO, name: "Co" } as unknown as Company],
    agents: [agent("agent-ana"), agent("agent-bo")],
    accessMembers: [{ id: "m1", companyId: CO, principalType: "user", principalId: "owner-user", status: "active", membershipRole: "owner", grants: [], createdAt: "", updatedAt: "" } as unknown as PluginAccessMember],
  });
  await plugin.definition.setup(h.ctx);
  const tick = (now: Date) => tickPerson(h.ctx, CO, settings, ana, now);
  const runRow = () => db.tables.night_runs.find((r) => r.owner === ana.email)!;
  const event = (taskId: string) => db.tables.task_events.find((r) => r.task_id === taskId)!;
  const run = { agentId: "agent-ana", runId: "run-1", companyId: CO, projectId: "proj-1" };
  return { h, db, tick, runRow, event, run };
}

async function proposedNight() {
  const t = await setup();
  await t.tick(EVENING);
  const res = await t.h.executeTool<{ error?: string; data: { planIssueId: string; taskIds: string[] } }>(
    TOOL_PROPOSE,
    { tasks: [{ title: "Fix login" }, { title: "Write docs", description: "README section" }] },
    t.run,
  );
  expect(res.error).toBeUndefined();
  return { ...t, plan: res.data.planIssueId, tasks: res.data.taskIds };
}

async function approve(t: Awaited<ReturnType<typeof proposedNight>>, action: "accept" | "reject" = "accept") {
  const [interaction] = await t.h.ctx.issues.listInteractions(t.plan, CO);
  await t.h.ctx.issues.respondInteraction(t.plan, interaction!.id, { action, actorUserId: "owner-user" }, CO);
}

describe("evening proposal", () => {
  it("opens exactly one plan ticket per person per night, assigned to their agent", async () => {
    const t = await setup();
    expect((await t.tick(new Date("2026-10-21T12:00:00Z"))).kind).toBe("none");
    expect((await t.tick(EVENING)).kind).toBe("open-plan");
    await t.tick(new Date(EVENING.getTime() + 5 * 60_000));
    expect(t.db.tables.night_runs).toHaveLength(1);
    const plans = (await t.h.ctx.issues.list({ companyId: CO })).filter((i) => i.originKind === PLAN_ORIGIN);
    expect(plans).toHaveLength(1);
    expect(plans[0]).toMatchObject({ assigneeAgentId: "agent-ana", status: "todo" });
  });

  it("creates backlog tasks with their own worktree and asks the owner (board only) to approve", async () => {
    const t = await proposedNight();
    for (const id of t.tasks) {
      const issue = await t.h.ctx.issues.get(id, CO);
      expect(issue).toMatchObject({ status: "backlog", assigneeAgentId: "agent-ana", originKind: NIGHT_TASK_ORIGIN, projectId: "proj-1" });
      expect(issue?.executionWorkspaceSettings).toMatchObject({ workspaceStrategy: { type: "git_worktree" } });
      expect(t.event(id).proposed_at).toBeTruthy();
    }
    const [interaction] = await t.h.ctx.issues.listInteractions(t.plan, CO);
    expect(interaction).toMatchObject({ kind: "request_confirmation", status: "pending" });
    expect(t.runRow().status).toBe("awaiting_approval");
    expect((await t.h.ctx.issues.get(t.plan, CO))?.status).toBe("in_review");
  });

  it("refuses more tasks than the person's limit (and never more than 3)", async () => {
    const t = await setup();
    await t.tick(EVENING);
    const res = await t.h.executeTool<{ error?: string }>(TOOL_PROPOSE, { tasks: [{ title: "a" }, { title: "b" }, { title: "c" }] }, t.run);
    expect(res.error).toBe("propose at most 2 tasks");
  });

  it("refuses when no plan is open, or a second proposal for the same night", async () => {
    const t = await setup();
    expect((await t.h.executeTool<{ error?: string }>(TOOL_PROPOSE, { tasks: [{ title: "a" }] }, t.run)).error).toBe(
      "no evening plan is open for you right now",
    );
    const p = await proposedNight();
    expect((await p.h.executeTool<{ error?: string }>(TOOL_PROPOSE, { tasks: [{ title: "again" }] }, p.run)).error).toBe(
      "no evening plan is open for you right now",
    );
  });

  it("can pick up a handed-off backlog ticket, but not someone else's", async () => {
    const t = await setup();
    t.h.seed({
      issues: [
        { id: "mine", companyId: CO, title: "from Bo", status: "backlog", assigneeAgentId: "agent-ana" } as unknown as Issue,
        { id: "bos", companyId: CO, title: "Bo's", status: "backlog", assigneeAgentId: "agent-bo" } as unknown as Issue,
      ],
    });
    await t.tick(EVENING);
    expect((await t.h.executeTool<{ error?: string }>(TOOL_PROPOSE, { tasks: [{ issueId: "bos" }] }, t.run)).error).toBe(
      "you can only propose tickets assigned to you",
    );
    const ok = await t.h.executeTool<{ error?: string; data: { taskIds: string[] } }>(TOOL_PROPOSE, { tasks: [{ issueId: "mine" }] }, t.run);
    expect(ok.data.taskIds).toEqual(["mine"]);
  });
});

describe("approval and the night routine", () => {
  it("approval alone starts nothing; the first task starts at night start", async () => {
    const t = await proposedNight();
    await approve(t);
    expect((await t.tick(EVENING)).kind).toBe("approve");
    expect(t.event(t.tasks[0]!).approved_at).toBeTruthy();
    expect((await t.tick(new Date(EVENING.getTime() + 10 * 60_000))).kind).toBe("none");
    expect((await t.h.ctx.issues.get(t.tasks[0]!, CO))?.status).toBe("backlog");

    await t.tick(NIGHT);
    expect((await t.h.ctx.issues.get(t.tasks[0]!, CO))?.status).toBe("todo");
    expect(t.runRow()).toMatchObject({ status: "running", current_index: 0 });
    expect(t.event(t.tasks[0]!).started_at).toBeTruthy();
  });

  it("works through the tasks one at a time and finishes", async () => {
    const t = await proposedNight();
    await approve(t);
    await t.tick(EVENING);
    await t.tick(NIGHT);
    await t.h.ctx.issues.update(t.tasks[0]!, { status: "done" }, CO);
    await t.tick(new Date(NIGHT.getTime() + 10 * 60_000));
    expect((await t.h.ctx.issues.get(t.tasks[1]!, CO))?.status).toBe("todo");
    expect(t.event(t.tasks[0]!).finished_at).toBeTruthy();
    await t.h.ctx.issues.update(t.tasks[1]!, { status: "in_review" }, CO);
    await t.tick(new Date(NIGHT.getTime() + 20 * 60_000));
    expect(t.runRow()).toMatchObject({ status: "finished", stop_reason: "all tasks done" });
  });

  it("a rejected plan records the reason and runs nothing", async () => {
    const t = await proposedNight();
    await approve(t, "reject");
    expect((await t.tick(EVENING)).kind).toBe("reject");
    expect(t.runRow().status).toBe("rejected");
    expect(t.event(t.tasks[0]!).outcome).toBe("rejected");
    await t.tick(NIGHT);
    expect((await t.h.ctx.issues.get(t.tasks[0]!, CO))?.status).toBe("backlog");
  });
});

describe("budget cap", () => {
  it("stops the night and blocks the running task when spend reaches the cap", async () => {
    const t = await proposedNight();
    await approve(t);
    await t.tick(EVENING);
    await t.tick(NIGHT);
    t.db.costs.push({ company_id: CO, agent_id: "agent-ana", cost_cents: 500, occurred_at: new Date(NIGHT.getTime() + 60_000) });
    await t.tick(new Date(NIGHT.getTime() + 5 * 60_000));
    expect(t.runRow().status).toBe("budget_stopped");
    expect((await t.h.ctx.issues.get(t.tasks[0]!, CO))?.status).toBe("blocked");
    expect(t.event(t.tasks[0]!).outcome).toBe("blocked");
    expect((await t.h.ctx.issues.get(t.tasks[1]!, CO))?.status).toBe("backlog");
  });

  it("spend from before the night does not count", async () => {
    const t = await proposedNight();
    await approve(t);
    await t.tick(EVENING);
    t.db.costs.push({ company_id: CO, agent_id: "agent-ana", cost_cents: 9999, occurred_at: EVENING });
    await t.tick(NIGHT);
    expect(t.runRow().status).toBe("running");
  });
});

describe("time-outs and retries", () => {
  it("retries a stuck task once, then fails it and moves on", async () => {
    const t = await proposedNight();
    await approve(t);
    await t.tick(EVENING);
    await t.tick(NIGHT);
    await t.h.ctx.issues.update(t.tasks[0]!, { status: "in_progress" }, CO);

    const retry = await t.tick(new Date(NIGHT.getTime() + 61 * 60_000));
    expect(retry).toEqual({ kind: "retry-step", attempt: 2 });
    expect((await t.h.ctx.issues.get(t.tasks[0]!, CO))?.status).toBe("todo");
    expect(t.runRow().current_attempt).toBe(2);

    await t.h.ctx.issues.update(t.tasks[0]!, { status: "in_progress" }, CO);
    await t.tick(new Date(NIGHT.getTime() + 123 * 60_000));
    expect(t.event(t.tasks[0]!).outcome).toBe("failed");
    expect((await t.h.ctx.issues.get(t.tasks[0]!, CO))?.status).toBe("blocked");
    expect((await t.h.ctx.issues.get(t.tasks[1]!, CO))?.status).toBe("todo");
  });
});
