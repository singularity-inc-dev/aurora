import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import type { Agent, Company, Issue, PluginAccessMember, Project } from "@paperclipai/plugin-sdk";
import manifest from "../src/manifest.js";
import plugin from "../src/worker.js";
import { parseSettings } from "../src/config.js";
import { startHandoverNow, tickPerson } from "../src/handoverrunner.js";
import { TOOL_PROPOSE } from "../src/tools.js";
import { HANDOFF_ORIGIN, HANDOVER_TASK_ORIGIN, PLAN_ORIGIN } from "../src/ids.js";
import { createFakeDb } from "./fakedb.js";
import { isolatedAgentFields, isolatedPersonFields } from "./helpers.js";

const CO = "co-1";
// Ana's night starts at 22:00 UTC; the evening plan opens at 20:00.
const EVENING = new Date("2026-10-21T20:30:00Z");
const NIGHT = new Date("2026-10-21T22:05:00Z");
const config = {
  night: { projectId: "proj-1", stepTimeoutMinutes: 60, maxRetries: 1 },
  people: [
    { email: "ana@example.com", agentId: "agent-ana", ...isolatedPersonFields("agent-ana"), timezone: "UTC", handoverStartHour: 22, handoverBudgetCapCents: 500, maxTasksPerHandover: 2 },
    { email: "bo@example.com", agentId: "agent-bo", ...isolatedPersonFields("agent-bo"), githubLogin: "bo-dev", timezone: "UTC", handoverStartHour: 22, handoverBudgetCapCents: 500 },
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
  const agent = (id: string) => ({ ...isolatedAgentFields(id), id, companyId: CO, name: id, role: "engineer", status: "idle", permissions: { canCreateAgents: false, canCreateSkills: false } }) as unknown as Agent;
  h.seed({
    companies: [{ id: CO, name: "Co" } as unknown as Company],
    agents: [agent("agent-ana"), agent("agent-bo")],
    accessMembers: [{ id: "m1", companyId: CO, principalType: "user", principalId: "owner-user", status: "active", membershipRole: "owner", grants: [], createdAt: "", updatedAt: "" } as unknown as PluginAccessMember],
  });
  await plugin.definition.setup(h.ctx);
  const tick = (now: Date) => tickPerson(h.ctx, CO, settings, ana, now);
  const runRow = () => db.tables.handover_runs.find((r) => r.owner === ana.email)!;
  const event = (taskId: string) => db.tables.task_events.find((r) => r.task_id === taskId)!;
  const run = { agentId: "agent-ana", runId: "run-1", companyId: CO, projectId: "proj-1" };
  return { h, db, tick, runRow, event, run };
}

async function proposedNight() {
  const t = await setup();
  await t.tick(EVENING);
  const res = await t.h.executeTool<{ error?: string; data: { planIssueId: string; taskIds: string[] } }>(
    TOOL_PROPOSE,
    { tasks: [{ title: "Fix login", claims: ["src/"] }, { title: "Write docs", description: "README section", claims: ["src/"] }] },
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
    expect(t.db.tables.handover_runs).toHaveLength(1);
    const plans = (await t.h.ctx.issues.list({ companyId: CO })).filter((i) => i.originKind === PLAN_ORIGIN);
    expect(plans).toHaveLength(1);
    expect(plans[0]).toMatchObject({ assigneeAgentId: "agent-ana", status: "todo" });
  });

  it("creates backlog tasks with their own worktree and asks the owner (board only) to approve", async () => {
    const t = await proposedNight();
    for (const id of t.tasks) {
      const issue = await t.h.ctx.issues.get(id, CO);
      expect(issue).toMatchObject({ status: "backlog", assigneeAgentId: "agent-ana", originKind: HANDOVER_TASK_ORIGIN, projectId: "proj-1" });
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
    const res = await t.h.executeTool<{ error?: string }>(TOOL_PROPOSE, { tasks: [{ title: "a", claims: ["src/"] }, { title: "b", claims: ["src/"] }, { title: "c", claims: ["src/"] }] }, t.run);
    expect(res.error).toBe("propose at most 2 tasks");
  });

  it("refuses when no plan is open, or a second proposal for the same night", async () => {
    const t = await setup();
    expect((await t.h.executeTool<{ error?: string }>(TOOL_PROPOSE, { tasks: [{ title: "a", claims: ["src/"] }] }, t.run)).error).toBe(
      "no handover plan is open for you right now",
    );
    const p = await proposedNight();
    expect((await p.h.executeTool<{ error?: string }>(TOOL_PROPOSE, { tasks: [{ title: "again", claims: ["src/"] }] }, p.run)).error).toBe(
      "no handover plan is open for you right now",
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
    expect((await t.h.executeTool<{ error?: string }>(TOOL_PROPOSE, { tasks: [{ issueId: "bos", claims: ["src/"] }] }, t.run)).error).toBe(
      "you can only propose tickets assigned to you",
    );
    const ok = await t.h.executeTool<{ error?: string; data: { taskIds: string[] } }>(TOOL_PROPOSE, { tasks: [{ issueId: "mine", claims: ["src/"] }] }, t.run);
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

describe("Hand over now", () => {
  // 14:05 UTC: far from Ana's scheduled handover at 22:00.
  const AFTERNOON = new Date("2026-10-21T14:05:00Z");

  it("starts a handover at once: plan, approval, then work right away", async () => {
    const t = await setup();
    const started = await startHandoverNow(t.h.ctx, CO, settings, ana, AFTERNOON);
    expect(started).toMatchObject({ ok: true, handoverKey: "2026-10-21T14:05:00" });
    expect(t.runRow()).toMatchObject({ kind: "now", handover_key: "2026-10-21T14:05:00", status: "proposing" });
    const planId = (started as { planIssueId: string }).planIssueId;
    expect((await t.h.ctx.issues.get(planId, CO))?.title).toContain("handover now");

    const res = await t.h.executeTool<{ error?: string; data: { taskIds: string[] } }>(TOOL_PROPOSE, { tasks: [{ title: "Fix login", claims: ["src/"] }] }, t.run);
    expect(res.error).toBeUndefined();
    await approve({ ...t, plan: planId, tasks: res.data.taskIds });
    const soon = new Date(AFTERNOON.getTime() + 2 * 60_000);
    expect((await t.tick(soon)).kind).toBe("approve");
    expect((await t.tick(soon)).kind).toBe("advance");
    expect((await t.h.ctx.issues.get(res.data.taskIds[0]!, CO))?.status).toBe("todo");
  });

  it("only one handover at a time", async () => {
    const t = await setup();
    expect((await startHandoverNow(t.h.ctx, CO, settings, ana, AFTERNOON)).ok).toBe(true);
    expect(await startHandoverNow(t.h.ctx, CO, settings, ana, new Date(AFTERNOON.getTime() + 60_000))).toEqual({ ok: false, message: "a handover is already in progress (proposing)" });
  });

  it("refuses an agent that is not locked down", async () => {
    const t = await setup();
    const loose = { ...ana, agentEnvironmentId: "someone-elses" };
    expect(await startHandoverNow(t.h.ctx, CO, settings, loose, AFTERNOON)).toMatchObject({ ok: false, message: expect.stringContaining("not locked down") });
  });
});

/** A real repository with a CODEOWNERS file: Ana owns src/ui, Bo owns src/api. */
function repoWithOwners(codeowners = "/src/ui/  ana@example.com\n/src/api/  @bo-dev\n"): string {
  const dir = mkdtempSync(path.join(tmpdir(), "vt-owners-"));
  const g = (...args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "pipe" });
  g("init", "-q", "-b", "main");
  g("config", "user.email", "t@example.com");
  g("config", "user.name", "t");
  mkdirSync(path.join(dir, "src/api"), { recursive: true });
  writeFileSync(path.join(dir, "src/api/search.ts"), "x\n");
  writeFileSync(path.join(dir, "CODEOWNERS"), codeowners);
  g("add", ".");
  g("commit", "-qm", "init");
  return dir;
}

describe("claims and the pre-handover check", () => {
  type Proposed = { error?: string; content?: string; data: { planIssueId: string; taskIds: string[]; moved: Array<{ title: string; ticketId: string; keeper: string }>; questions: string[] } };
  const workspace = (dir: string) =>
    ({ id: "ws-1", projectId: "proj-1", name: "repo", path: dir, repoUrl: null, repoRef: null, defaultRef: "main", isPrimary: true, createdAt: "", updatedAt: "" });
  const bo = settings.people[1]!;
  const boRun = { agentId: "agent-bo", runId: "run-2", companyId: CO, projectId: "proj-1" };

  it("refuses a task that does not say which files it may change", async () => {
    const t = await setup();
    await t.tick(EVENING);
    const res = await t.h.executeTool<{ error?: string }>(TOOL_PROPOSE, { tasks: [{ title: "Fix login" }] }, t.run);
    expect(res.error).toMatch(/^task 1: list the files and folders it may change \(claims\)/);
    expect((await t.h.executeTool<{ error?: string }>(TOOL_PROPOSE, { tasks: [{ title: "x", claims: ["../etc"] }] }, t.run)).error).toMatch(/must be a path inside the repository/);
  });

  it("a task in another owner's area goes to that owner's agent, and the owner is asked", async () => {
    const t = await setup();
    t.h.seed({ projects: [{ id: "proj-1", companyId: CO, name: "App" } as unknown as Project], projectWorkspaces: [workspace(repoWithOwners())] });
    await t.tick(EVENING);
    const res = await t.h.executeTool<Proposed>(
      TOOL_PROPOSE,
      { tasks: [{ title: "Search box", claims: ["src/ui/search.tsx"] }, { title: "Search API", claims: ["src/api/search.ts"] }] },
      t.run,
    );
    expect(res.error).toBeUndefined();
    expect(res.data.taskIds).toHaveLength(1);
    expect(res.data.moved).toMatchObject([{ title: "Search API", keeper: "bo@example.com" }]);
    expect(res.content).toContain("went to their agent");

    const ticket = await t.h.ctx.issues.get(res.data.moved[0]!.ticketId, CO);
    expect(ticket).toMatchObject({ assigneeAgentId: "agent-bo", status: "backlog", originKind: HANDOFF_ORIGIN });
    expect(ticket?.description).toContain("is in bo@example.com's area (CODEOWNERS line 2)");
    expect(t.event(ticket!.id)).toMatchObject({ handed_off_to: "bo@example.com" });
    expect(t.db.tables.overlaps).toMatchObject([{ owner: "ana@example.com", keeper: "bo@example.com", kind: "area", claim: "src/api/search.ts", ticket_id: ticket!.id }]);

    const kept = res.data.taskIds[0]!;
    expect(JSON.parse(String(t.event(kept).claims))).toEqual(["src/ui/search.tsx"]);
    expect(t.runRow().task_ids).toBe(JSON.stringify([kept]));
    const [interaction] = await t.h.ctx.issues.listInteractions(res.data.planIssueId, CO);
    const details = (interaction as unknown as { payload: { detailsMarkdown: string } }).payload.detailsMarkdown;
    expect(details).toContain("claims `src/ui/search.tsx`");
    expect(details).toContain("**Pre-handover check: one question**");
    expect(details).toContain('1. "Search API": `src/api/search.ts` is in bo@example.com\'s area');
  });

  it("a GitHub team in CODEOWNERS: the plan warns, naming the team, and the admin's view lists it", async () => {
    const t = await setup();
    t.h.seed({ projects: [{ id: "proj-1", companyId: CO, name: "App" } as unknown as Project], projectWorkspaces: [workspace(repoWithOwners("/src/ui/  ana@example.com\n/src/api/  @acme/backend\n"))] });
    await t.tick(EVENING);
    const res = await t.h.executeTool<Proposed>(TOOL_PROPOSE, { tasks: [{ title: "Search API", claims: ["src/api/search.ts"] }] }, t.run);
    expect(res.data.taskIds).toHaveLength(1); // nobody is matched through a team
    const [interaction] = await t.h.ctx.issues.listInteractions(res.data.planIssueId, CO);
    const details = (interaction as unknown as { payload: { detailsMarkdown: string } }).payload.detailsMarkdown;
    expect(details).toContain("_WARNING: CODEOWNERS names GitHub team @acme/backend (line 2).");
    expect(details).toContain("list the people instead");
    const view = await t.h.getData<{ ok: boolean; source: string; teams: unknown[] }>("codeowners", { companyId: CO });
    expect(view).toEqual({ ok: true, source: "CODEOWNERS", teams: [{ team: "@acme/backend", lines: [2] }], notes: [expect.stringContaining("WARNING")] });
  });

  it("a later claim on the same files goes to the owner who claimed them first", async () => {
    const t = await setup();
    await tickPerson(t.h.ctx, CO, settings, bo, EVENING);
    const first = await t.h.executeTool<Proposed>(TOOL_PROPOSE, { tasks: [{ title: "Rewrite docs", claims: ["docs/"] }] }, boRun);
    expect(first.data.taskIds).toHaveLength(1);
    await t.tick(EVENING);
    const later = await t.h.executeTool<Proposed>(TOOL_PROPOSE, { tasks: [{ title: "Fix a typo", claims: ["docs/guide.md"] }] }, t.run);
    expect(later.data.taskIds).toEqual([]);
    expect(later.data.moved).toMatchObject([{ keeper: "bo@example.com" }]);
    expect(later.data.questions[0]).toContain('overlaps `docs`, claimed by bo@example.com\'s task "Rewrite docs"');
    expect(t.db.tables.overlaps).toMatchObject([{ kind: "claim", claim: "docs/guide.md" }]);
  });

  it("claims end when the task is decided or its plan expires", async () => {
    const t = await setup();
    await tickPerson(t.h.ctx, CO, settings, bo, EVENING);
    const first = await t.h.executeTool<Proposed>(TOOL_PROPOSE, { tasks: [{ title: "Rewrite docs", claims: ["docs/"] }] }, boRun);
    // Nobody approves Bo's plan; it expires when Bo's handover ends.
    await tickPerson(t.h.ctx, CO, settings, bo, new Date("2026-10-22T06:30:00Z"));
    expect(t.db.tables.task_events.find((r) => r.task_id === first.data.taskIds[0])?.claims_released_at).toBeTruthy();
    await t.tick(new Date("2026-10-22T20:30:00Z"));
    const later = await t.h.executeTool<Proposed>(TOOL_PROPOSE, { tasks: [{ title: "Fix a typo", claims: ["docs/guide.md"] }] }, t.run);
    expect(later.data.moved).toEqual([]);
  });

  describe("a proposal that fails halfway releases its claims (B1)", () => {
    const boHolds = (t: Awaited<ReturnType<typeof setup>>) =>
      t.db.tables.task_events.filter((r) => r.owner === "bo@example.com" && r.claims && !r.claims_released_at && !r.outcome);
    const anaTriesDocs = async (t: Awaited<ReturnType<typeof setup>>) => {
      await t.tick(EVENING);
      return t.h.executeTool<Proposed>(TOOL_PROPOSE, { tasks: [{ title: "Fix a typo", claims: ["docs/guide.md"] }] }, t.run);
    };

    it("on failure: asking for the plan approval throws", async () => {
      const t = await setup();
      await tickPerson(t.h.ctx, CO, settings, bo, EVENING);
      const confirm = t.h.ctx.issues.requestConfirmation;
      t.h.ctx.issues.requestConfirmation = async () => {
        throw new Error("Paperclip is down");
      };
      const failed = await t.h
        .executeTool<{ error?: string }>(TOOL_PROPOSE, { tasks: [{ title: "Rewrite docs", claims: ["docs/"] }] }, boRun)
        .catch((err: Error) => ({ error: err.message }));
      expect(failed.error).toBe("Paperclip is down");
      expect(boHolds(t)).toEqual([]);
      t.h.ctx.issues.requestConfirmation = confirm;
      const later = await anaTriesDocs(t);
      expect(later.data.moved).toEqual([]);
    });

    it("on failure: the run changed while proposing", async () => {
      const t = await setup();
      await tickPerson(t.h.ctx, CO, settings, bo, EVENING);
      const confirm = t.h.ctx.issues.requestConfirmation.bind(t.h.ctx.issues);
      t.h.ctx.issues.requestConfirmation = async (...args: Parameters<typeof confirm>) => {
        t.db.tables.handover_runs.find((r) => r.owner === "bo@example.com")!.status = "expired";
        return confirm(...args);
      };
      const failed = await t.h.executeTool<{ error?: string }>(TOOL_PROPOSE, { tasks: [{ title: "Rewrite docs", claims: ["docs/"] }] }, boRun);
      expect(failed.error).toBe("the handover plan changed while proposing; try again");
      expect(boHolds(t)).toEqual([]);
    });

    it("a failure after the run is saved keeps the claims: they belong to that plan now", async () => {
      const t = await setup();
      await tickPerson(t.h.ctx, CO, settings, bo, EVENING);
      const update = t.h.ctx.issues.update.bind(t.h.ctx.issues);
      t.h.ctx.issues.update = async (...args: Parameters<typeof update>) => {
        if ((args[1] as { status?: string }).status === "in_review") throw new Error("Paperclip is down");
        return update(...args);
      };
      await t.h.executeTool(TOOL_PROPOSE, { tasks: [{ title: "Rewrite docs", claims: ["docs/"] }] }, boRun).catch(() => null);
      expect(t.db.tables.handover_runs.find((r) => r.owner === "bo@example.com")!.status).toBe("awaiting_approval");
      expect(boHolds(t)).toHaveLength(1);
    });

    it("on restart or time-out: claims a crash left behind end when that plan expires, never while it is still proposing", async () => {
      const t = await setup();
      await tickPerson(t.h.ctx, CO, settings, bo, EVENING);
      // What a crash between storing claims and saving the run leaves: claims, and a run that lists no tasks.
      t.db.tables.task_events.push({ task_id: "crashed", company_id: CO, owner: "bo@example.com", agent: "agent-bo", task_kind: "task", claims: JSON.stringify(["docs/"]) });
      await tickPerson(t.h.ctx, CO, settings, bo, new Date(EVENING.getTime() + 5 * 60_000));
      expect(boHolds(t)).toHaveLength(1); // Bo's plan is still open: a proposal may be in flight
      await tickPerson(t.h.ctx, CO, settings, bo, NIGHT); // the plan expires: no tasks were proposed in time
      expect(t.db.tables.handover_runs.find((r) => r.owner === "bo@example.com")!.status).toBe("expired");
      expect(boHolds(t)).toEqual([]);
      const later = await anaTriesDocs(t);
      expect(later.data.moved).toEqual([]);
    });

    it("claims of tasks a handover lists are never swept", async () => {
      const t = await setup();
      await tickPerson(t.h.ctx, CO, settings, bo, EVENING);
      await t.h.executeTool<Proposed>(TOOL_PROPOSE, { tasks: [{ title: "Rewrite docs", claims: ["docs/"] }] }, boRun);
      await tickPerson(t.h.ctx, CO, settings, bo, new Date(EVENING.getTime() + 5 * 60_000));
      expect(boHolds(t)).toHaveLength(1);
    });
  });

  it("never passes on a guess: an unreadable repository refuses the proposal", async () => {
    const t = await setup();
    t.h.seed({ projects: [{ id: "proj-1", companyId: CO, name: "App" } as unknown as Project], projectWorkspaces: [workspace(path.join(tmpdir(), "vt-no-such-repo"))] });
    await t.tick(EVENING);
    const res = await t.h.executeTool<{ error?: string }>(TOOL_PROPOSE, { tasks: [{ title: "x", claims: ["src/"] }] }, t.run);
    expect(res.error).toBe("the project's repository could not be read for the pre-handover check");
    expect(await t.h.ctx.issues.list({ companyId: CO, assigneeAgentId: "agent-ana", status: "backlog" })).toEqual([]);
  });
});
