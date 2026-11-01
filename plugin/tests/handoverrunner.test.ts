import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import type { Agent, Company, Issue, PluginApiRequestInput, Project } from "@paperclipai/plugin-sdk";
import manifest from "../src/manifest.js";
import plugin from "../src/worker.js";
import { parseSettings, type Person } from "../src/config.js";
import { askForSuggestions, handOver, parseHandoverRequest, tickPerson, withdrawQueued, type HandoverRequest } from "../src/handoverrunner.js";
import { TOOL_HANDOFF, TOOL_PROPOSE } from "../src/tools.js";
import { HANDOVER_TASK_ORIGIN, PLAN_ORIGIN } from "../src/ids.js";
import { renderBriefing } from "../src/briefing.js";
import { createFakeDb } from "./fakedb.js";
import { isolatedAgentFields, isolatedPersonFields } from "./helpers.js";

const CO = "co-1";
// Ana's scheduled handover starts at 22:00 UTC and lasts 8 hours.
const DAY = new Date("2026-10-21T14:05:00Z");
const NIGHT = new Date("2026-10-21T22:05:00Z");
const baseConfig = {
  serviceUserId: "svc-user",
  handover: { projectId: "proj-1", stepTimeoutMinutes: 60, maxRetries: 1 },
  links: { baseUrl: "http://mail.test", signingSecret: { type: "secret_ref", secretId: "sig" }, expiresMinutes: 60 },
  people: [
    { email: "ana@example.com", agentId: "agent-ana", ...isolatedPersonFields("agent-ana"), timezone: "UTC", handoverStartHour: 22, handoverBudgetCapCents: 500, maxTasksPerHandover: 2 },
    { email: "bo@example.com", agentId: "agent-bo", ...isolatedPersonFields("agent-bo"), githubLogin: "bo-dev", timezone: "UTC", handoverStartHour: 22, handoverBudgetCapCents: 500 },
  ],
};
const settingsOf = (config: unknown) => {
  const r = parseSettings(config);
  if (!r.ok) throw new Error(r.errors.join(";"));
  return r.settings;
};
const settings = settingsOf(baseConfig);
const ana = settings.people[0]!;
const bo = settings.people[1]!;

const ticket = (id: string, assignee: string, o: Record<string, unknown> = {}) =>
  ({ id, companyId: CO, identifier: id.toUpperCase(), title: `Title ${id}`, description: `Description ${id}`, status: "backlog", assigneeAgentId: assignee, projectId: "proj-1", ...o }) as unknown as Issue;

async function setup(config: Record<string, unknown> = baseConfig) {
  // The tests read ticket comments; the plugin itself never needs to.
  const h = createTestHarness({ manifest, capabilities: [...manifest.capabilities, "issue.comments.read" as const], config });
  const db = createFakeDb();
  (h.ctx as { db: unknown }).db = db;
  const agent = (id: string) => ({ ...isolatedAgentFields(id), id, companyId: CO, name: id, role: "engineer", status: "idle", permissions: { canCreateAgents: false, canCreateSkills: false } }) as unknown as Agent;
  h.seed({
    companies: [{ id: CO, name: "Co" } as unknown as Company],
    agents: [agent("agent-ana"), agent("agent-bo")],
    issues: [ticket("a1", "agent-ana"), ticket("a2", "agent-ana"), ticket("a3", "agent-ana"), ticket("b1", "agent-bo")],
  });
  await plugin.definition.setup(h.ctx);
  const s = settingsOf(config);
  const me = s.people[0]!;
  const tick = (now: Date, who: Person = me) => tickPerson(h.ctx, CO, s, who, now);
  const runRow = (owner = me.email) => db.tables.handover_runs.find((r) => r.owner === owner);
  const event = (taskId: string) => db.tables.task_events.find((r) => r.task_id === taskId)!;
  const status = async (id: string) => (await h.ctx.issues.get(id, CO))?.status;
  const run = { agentId: "agent-ana", runId: "run-1", companyId: CO, projectId: "proj-1" };
  const api = async (routeKey: string, body: Record<string, unknown>) =>
    (await plugin.definition.onApiRequest!({
      routeKey,
      method: "POST",
      path: "",
      params: {},
      query: {},
      body,
      actor: { actorType: "user", actorId: "svc-user", userId: "svc-user" },
      companyId: CO,
      headers: {},
    } as PluginApiRequestInput)) as { status: number; body: Record<string, any> };
  return { h, db, s, me, tick, runRow, event, status, run, api };
}

const note = (issueId: string, o: Record<string, unknown> = {}) => ({ issueId, what: `Do ${issueId}`, doneWhen: `${issueId} works`, files: `${issueId}.txt`, ...o });
const request = (when: "now" | "scheduled", tasks: Array<Record<string, unknown>>, who: Person = ana): HandoverRequest => {
  const r = parseHandoverRequest({ when, tasks }, settings, who);
  if (typeof r === "string") throw new Error(r);
  return r;
};

describe("1. a handover note per task, stored in one place", () => {
  it("the owner's note (what, done when, files, time, budget) is stored in handover_notes and given to the agent as its brief", async () => {
    const t = await setup();
    const res = await handOver(t.h.ctx, CO, settings, ana, request("now", [note("a1", { maxMinutes: "30", budgetCents: "120", files: "src/login/, a1.txt" })]), DAY);
    expect(res.ok).toBe(true);
    expect(t.db.tables.handover_notes).toHaveLength(1);
    expect(t.db.tables.handover_notes[0]).toMatchObject({
      task_id: "a1",
      owner: "ana@example.com",
      source: "owner",
      status: "handed_over",
      schedule: "now",
      what: "Do a1",
      done_when: "a1 works",
      claims: JSON.stringify(["src/login", "a1.txt"]),
      max_minutes: 30,
      budget_cents: 120,
      submitted_by: "ana@example.com",
    });
    const comments = await t.h.ctx.issues.listComments("a1", CO);
    expect(comments.map((c) => c.body).join("\n")).toMatch(/What to do:\*\* Do a1[\s\S]*Done when:\*\* a1 works[\s\S]*`src\/login`, `a1.txt`[\s\S]*30 minutes[\s\S]*120 cents/);
    // The event log still has one row per task, and the claims come from the note.
    expect(JSON.parse(String(t.event("a1").claims))).toEqual(["src/login", "a1.txt"]);
  });

  it("refuses an incomplete note, or more tasks than the person's limit, before anything changes", () => {
    expect(parseHandoverRequest({ when: "now", tasks: [note("a1", { doneWhen: "" })] }, settings, ana)).toBe('ticket 1: write how you will know it is done ("Done when")');
    expect(parseHandoverRequest({ when: "now", tasks: [note("a1", { files: "" })] }, settings, ana)).toMatch(/^ticket 1: list the files/);
    expect(parseHandoverRequest({ when: "now", tasks: [note("a1", { budgetCents: "501" })] }, settings, ana)).toMatch(/budget must be 1 to 500 cents/);
    expect(parseHandoverRequest({ when: "now", tasks: [note("a1"), note("a2"), note("a3")] }, settings, ana)).toBe("choose at most 2 ticket(s)");
    expect(parseHandoverRequest({ when: "now", tasks: [note("a1"), note("a1")] }, settings, ana)).toBe("ticket 2: chosen twice");
    expect(parseHandoverRequest({ when: "tonight", tasks: [note("a1")] }, settings, ana)).toMatch(/choose Hand over now/);
  });
});

describe("2. Hand over now and scheduled handovers run exactly the owner's tickets", () => {
  it("Hand over now runs exactly the chosen tickets, in order, and nothing else from the backlog", async () => {
    const t = await setup();
    const res = await handOver(t.h.ctx, CO, settings, ana, request("now", [note("a2"), note("a1")]), DAY);
    expect(res).toMatchObject({ ok: true, when: "now", handoverKey: "2026-10-21T14:05:00", taskIds: ["a2", "a1"] });
    expect(t.runRow()).toMatchObject({ kind: "now", status: "running", task_ids: JSON.stringify(["a2", "a1"]), current_index: 0 });
    expect(await t.status("a2")).toBe("todo");
    expect(await t.status("a1")).toBe("backlog");
    expect(await t.status("a3")).toBe("backlog"); // not chosen: never touched
    await t.h.ctx.issues.update("a2", { status: "done" }, CO);
    await t.tick(new Date(DAY.getTime() + 5 * 60_000));
    expect(await t.status("a1")).toBe("todo");
    await t.h.ctx.issues.update("a1", { status: "done" }, CO);
    await t.tick(new Date(DAY.getTime() + 10 * 60_000));
    expect(t.runRow()).toMatchObject({ status: "finished", stop_reason: "all tasks done" });
    expect(await t.status("a3")).toBe("backlog");
  });

  it("a scheduled handover runs exactly the notes the owner queued, and starts at the scheduled time", async () => {
    const t = await setup();
    const res = await handOver(t.h.ctx, CO, settings, ana, request("scheduled", [note("a1")]), DAY);
    expect(res).toMatchObject({ ok: true, when: "scheduled", message: expect.stringContaining("22:00 UTC") });
    expect(t.db.tables.handover_notes[0]).toMatchObject({ status: "queued", schedule: "scheduled" });
    // A new ticket appears in the agent's backlog after the owner queued (e.g. the agent wrote it).
    t.h.seed({ issues: [ticket("sneaky", "agent-ana")] });
    await t.tick(new Date("2026-10-21T20:30:00Z"));
    expect(t.runRow()).toMatchObject({ status: "approved", kind: "scheduled", task_ids: JSON.stringify(["a1"]) });
    expect(await t.status("a1")).toBe("backlog"); // nothing before the window
    await t.tick(NIGHT);
    expect(t.runRow()).toMatchObject({ status: "running", task_ids: JSON.stringify(["a1"]) });
    expect(await t.status("a1")).toBe("todo");
    expect(await t.status("sneaky")).toBe("backlog");
    expect(t.db.tables.handover_notes[0]).toMatchObject({ status: "handed_over", handover_key: "2026-10-21" });
  });

  it("with nothing queued, the schedule starts nothing and opens no plan (agent proposals are off by default)", async () => {
    const t = await setup();
    for (const at of [new Date("2026-10-21T20:30:00Z"), NIGHT, new Date("2026-10-22T03:00:00Z")]) expect((await t.tick(at)).kind).toBe("none");
    expect(t.db.tables.handover_runs).toHaveLength(0);
    expect((await t.h.ctx.issues.list({ companyId: CO })).filter((i) => i.originKind === PLAN_ORIGIN)).toEqual([]);
    expect((await t.h.ctx.issues.list({ companyId: CO })).every((i) => i.status === "backlog")).toBe(true);
  });

  it("the owner can take queued tasks back before they start; then nothing runs and their files are free", async () => {
    const t = await setup();
    await handOver(t.h.ctx, CO, settings, ana, request("scheduled", [note("a1")]), DAY);
    expect((await withdrawQueued(t.h.ctx, CO, ana)).withdrawn).toBe(1);
    expect(t.event("a1").claims_released_at).toBeTruthy();
    await t.tick(NIGHT);
    expect(t.db.tables.handover_runs).toHaveLength(0);
    expect(await t.status("a1")).toBe("backlog");
  });

  it("refuses, changing nothing: a ticket not on the owner's agent, not in backlog, or already queued", async () => {
    const t = await setup();
    t.h.seed({ issues: [ticket("busy", "agent-ana", { status: "in_progress" })] });
    expect(await handOver(t.h.ctx, CO, settings, ana, request("now", [note("a1"), note("b1")]), DAY)).toEqual({ ok: false, message: "you can only hand over tickets assigned to your own agent" });
    expect(await handOver(t.h.ctx, CO, settings, ana, request("now", [note("busy")]), DAY)).toMatchObject({ ok: false, message: "ticket BUSY is not in backlog" });
    await handOver(t.h.ctx, CO, settings, ana, request("scheduled", [note("a1")]), DAY);
    expect(await handOver(t.h.ctx, CO, settings, ana, request("now", [note("a1")]), DAY)).toMatchObject({ ok: false, message: "ticket A1 already waits for your scheduled handover" });
    expect(await handOver(t.h.ctx, CO, settings, ana, request("scheduled", [note("a2"), note("a3")]), DAY)).toMatchObject({ ok: false, message: expect.stringContaining("at most 2 in all") });
    expect(t.db.tables.handover_runs).toHaveLength(0);
    expect(t.db.tables.handover_notes).toHaveLength(1);
  });

  it("only one handover at a time, and never for an agent that is not locked down", async () => {
    const t = await setup();
    expect((await handOver(t.h.ctx, CO, settings, ana, request("now", [note("a1")]), DAY)).ok).toBe(true);
    expect(await handOver(t.h.ctx, CO, settings, ana, request("now", [note("a2")]), DAY)).toEqual({ ok: false, message: "a handover is already in progress (running)" });
    const loose = { ...bo, agentEnvironmentId: "someone-elses" };
    expect(await handOver(t.h.ctx, CO, settings, loose, request("now", [note("b1")], loose), DAY)).toMatchObject({ ok: false, message: expect.stringContaining("not locked down") });
  });
});

describe("2. the agent may not add, swap or rewrite the owner's tasks", () => {
  it("cannot suggest tasks unless the owner turned on Help me plan (off by default)", async () => {
    const t = await setup();
    await handOver(t.h.ctx, CO, settings, ana, request("now", [note("a1")]), DAY);
    const res = await t.h.executeTool<{ error?: string }>(TOOL_PROPOSE, { tasks: [{ title: "Extra", claims: ["x/"] }] }, t.run);
    expect(res.error).toBe("your owner chooses the work; Help me plan is off, so you cannot suggest tasks");
    expect(JSON.parse(String(t.runRow()!.task_ids))).toEqual(["a1"]);
    expect((await t.h.ctx.issues.list({ companyId: CO })).map((i) => i.id).sort()).toEqual(["a1", "a2", "a3", "b1"]);
  });

  it("cannot hand a running or queued task of its owner's to someone else", async () => {
    const t = await setup();
    await handOver(t.h.ctx, CO, settings, ana, request("now", [note("a1")]), DAY);
    await handOver(t.h.ctx, CO, settings, ana, request("scheduled", [note("a2")]), DAY);
    for (const issueId of ["a1", "a2"]) {
      const res = await t.h.executeTool<{ error?: string }>(TOOL_HANDOFF, { toEmail: "bo@example.com", issueId }, t.run);
      expect(res.error).toBe("your owner handed this ticket over to you; only your owner can change that");
      expect((await t.h.ctx.issues.get(issueId, CO))?.assigneeAgentId).toBe("agent-ana");
    }
    // A ticket the owner did not hand over may still be passed on, through the board.
    expect((await t.h.executeTool<{ error?: string }>(TOOL_HANDOFF, { toEmail: "bo@example.com", issueId: "a3" }, t.run)).error).toBeUndefined();
  });

  it("editing the ticket changes nothing: the handback shows the locked note and says the ticket was edited", async () => {
    const t = await setup();
    await handOver(t.h.ctx, CO, settings, ana, request("now", [note("a1")]), DAY);
    await t.h.ctx.issues.update("a1", { description: "Actually, rewrite the whole app", status: "done" }, CO);
    await t.tick(new Date(DAY.getTime() + 5 * 60_000));
    expect(t.runRow()).toMatchObject({ status: "finished" });
    expect(t.db.tables.handover_notes[0]).toMatchObject({ what: "Do a1", done_when: "a1 works" });
    const b = t.db.tables.briefings[0]!;
    const item = JSON.parse(String(b.items))[0];
    expect(item.note).toMatchObject({ what: "Do a1", doneWhen: "a1 works", files: ["a1.txt"], ticketEdited: true });
    const email = renderBriefing(
      { id: String(b.id), companyId: CO, owner: ana.email, handoverKey: String(b.handover_key), items: JSON.parse(String(b.items)), notes: [], conflicts: [], shared: [], status: "pending" },
      settings.links!,
      "secret",
      new Date(DAY.getTime() + 3600_000),
    );
    expect(email.text).toContain("You asked: Do a1");
    expect(email.text).toContain("Done when (your words; Aurora does not check this, you do): a1 works");
    expect(email.text).toContain("Limits: only a1.txt; 120 minutes; 500 cents.");
    expect(email.text).toContain("WARNING: the ticket's text was changed after you handed it over");
    expect(email.text).toContain("Only you can use these links");
  });
});

describe("3. the owner's tap is the approval: no plan step", () => {
  it("creates no plan ticket and no approval request; the tasks are approved at the tap", async () => {
    const t = await setup();
    await handOver(t.h.ctx, CO, settings, ana, request("now", [note("a1")]), DAY);
    const all = await t.h.ctx.issues.list({ companyId: CO });
    expect(all.filter((i) => i.originKind === PLAN_ORIGIN)).toEqual([]);
    for (const i of all) expect(await t.h.ctx.issues.listInteractions(i.id, CO)).toEqual([]);
    expect(t.event("a1").proposed_at).toBe(DAY.toISOString());
    expect(t.event("a1").approved_at).toBe(DAY.toISOString());
    expect(t.event("a1").started_at).toBe(DAY.toISOString());
  });

  it("a handover left waiting for the old plan approval ends without work", async () => {
    const t = await setup();
    t.db.tables.handover_runs.push({ company_id: CO, owner: ana.email, agent_id: "agent-ana", handover_key: "2026-10-21", kind: "scheduled", status: "awaiting_approval", task_ids: JSON.stringify(["a1"]), current_index: -1, current_attempt: 0 });
    expect((await t.tick(new Date("2026-10-21T20:30:00Z"))).kind).toBe("expire");
    expect(t.runRow()).toMatchObject({ status: "expired" });
    await t.tick(NIGHT);
    expect(await t.status("a1")).toBe("backlog");
  });
});

describe("4. only the owner hands over their own tasks", () => {
  it("the route acts for the owner the service names, on that owner's tickets only", async () => {
    const t = await setup();
    // Bo cannot hand over Ana's ticket: it is not on Bo's agent.
    const res = await t.api("handover-start", { email: "bo@example.com", when: "now", tasks: [note("a1")] });
    expect(res).toMatchObject({ status: 409, body: { ok: false, message: "you can only hand over tickets assigned to your own agent" } });
    expect((await t.api("handover-start", { email: "eve@example.com", when: "now", tasks: [note("a1")] })).status).toBe(404);
    const ok = await t.api("handover-start", { email: "ana@example.com", when: "now", tasks: [note("a1")] });
    expect(ok).toMatchObject({ status: 201, body: { ok: true, taskIds: ["a1"] } });
  });

  it("the status route lists only the owner's own backlog, with what waits", async () => {
    const t = await setup();
    await handOver(t.h.ctx, CO, settings, ana, request("scheduled", [note("a1")]), DAY);
    const res = await t.api("handover-status", { email: "ana@example.com" });
    expect(res.body).toMatchObject({ ok: true, maxTasks: 2, helpMePlan: false, limits: { defaultMinutes: 120, maxMinutes: 480, maxBudgetCents: 500 } });
    expect(res.body.tickets.map((x: { id: string }) => x.id)).toEqual(["a2", "a3"]);
    expect(res.body.queued).toMatchObject([{ taskId: "a1", doneWhen: "a1 works" }]);
    expect((await t.api("handover-withdraw", { email: "ana@example.com" })).body).toMatchObject({ ok: true, withdrawn: 1 });
  });
});

describe("5. Help me plan: off by default, and suggestions still need the owner's tap", () => {
  const withHelp = { ...baseConfig, people: [{ ...baseConfig.people[0]!, helpMePlan: true }, baseConfig.people[1]!] };

  it("is off by default: the owner cannot ask, the agent cannot suggest", async () => {
    const t = await setup();
    expect(await askForSuggestions(t.h.ctx, CO, settings, ana)).toMatchObject({ ok: false, message: expect.stringContaining("Help me plan is off") });
  });

  it("when on, the agent's suggestions are only drafts: nothing runs, now or on the schedule, until the owner hands them over", async () => {
    const t = await setup(withHelp);
    expect((await t.h.executeTool<{ error?: string }>(TOOL_PROPOSE, { tasks: [{ title: "x", claims: ["x/"] }] }, t.run)).error).toBe("your owner has not asked for suggestions");
    const asked = await askForSuggestions(t.h.ctx, CO, t.s, t.me);
    expect(asked).toMatchObject({ ok: true });
    expect(await t.h.ctx.issues.get(asked.planIssueId!, CO)).toMatchObject({ originKind: PLAN_ORIGIN, assigneeAgentId: "agent-ana" });

    const res = await t.h.executeTool<{ error?: string; data: { taskIds: string[] } }>(
      TOOL_PROPOSE,
      { tasks: [{ title: "Speed up search", description: "Cache results", doneWhen: "search under 200 ms", claims: ["src/search/"] }, { issueId: "a3", claims: ["a3.txt"] }] },
      t.run,
    );
    expect(res.error).toBeUndefined();
    const [newId] = res.data.taskIds;
    expect(await t.h.ctx.issues.get(newId!, CO)).toMatchObject({ status: "backlog", originKind: HANDOVER_TASK_ORIGIN, assigneeAgentId: "agent-ana" });
    expect(t.db.tables.handover_notes.map((n) => [n.task_id, n.source, n.status])).toEqual([
      [newId, "agent", "draft"],
      ["a3", "agent", "draft"],
    ]);
    expect(await t.status(asked.planIssueId!)).toBe("done");
    // No run, no claims, no work: on the schedule either.
    for (const at of [DAY, NIGHT]) await t.tick(at);
    expect(t.db.tables.handover_runs).toHaveLength(0);
    expect(await t.status(newId!)).toBe("backlog");
    expect(t.db.tables.task_events).toHaveLength(0);

    // The owner sees the drafts, edits one, and hands it over: the owner's note is what runs.
    const status = await t.api("handover-status", { email: "ana@example.com" });
    expect(status.body.tickets.find((x: { id: string }) => x.id === newId).draft).toMatchObject({ source: "agent", doneWhen: "search under 200 ms", files: "src/search" });
    const r = parseHandoverRequest({ when: "now", tasks: [{ issueId: newId, what: "Cache search results for 60 s", doneWhen: "p95 under 200 ms", files: "src/search/" }] }, t.s, t.me);
    expect((await handOver(t.h.ctx, CO, t.s, t.me, r as HandoverRequest, DAY)).ok).toBe(true);
    expect(t.db.tables.handover_notes.find((n) => n.task_id === newId && n.source === "agent")!.status).toBe("withdrawn");
    expect(t.db.tables.handover_notes.find((n) => n.task_id === newId && n.source === "owner")).toMatchObject({ status: "handed_over", what: "Cache search results for 60 s" });
    expect(JSON.parse(String(t.runRow()!.task_ids))).toEqual([newId]);
  });
});

describe("limits from the note are enforced", () => {
  it("a task over its own budget is blocked and the next one starts", async () => {
    const t = await setup();
    await handOver(t.h.ctx, CO, settings, ana, request("now", [note("a1", { budgetCents: "50" }), note("a2")]), DAY);
    t.db.costs.push({ company_id: CO, agent_id: "agent-ana", cost_cents: 50, occurred_at: new Date(DAY.getTime() + 60_000) });
    await t.tick(new Date(DAY.getTime() + 5 * 60_000));
    expect(t.event("a1").outcome).toBe("blocked");
    expect(await t.status("a1")).toBe("blocked");
    expect(await t.status("a2")).toBe("todo");
  });

  it("a task past its own time limit fails and the next one starts", async () => {
    const t = await setup();
    await handOver(t.h.ctx, CO, settings, ana, request("now", [note("a1", { maxMinutes: "20" }), note("a2")]), DAY);
    await t.h.ctx.issues.update("a1", { status: "in_progress" }, CO);
    await t.tick(new Date(DAY.getTime() + 15 * 60_000));
    expect(await t.status("a1")).toBe("in_progress");
    await t.tick(new Date(DAY.getTime() + 21 * 60_000));
    expect(t.event("a1").outcome).toBe("failed");
    expect(await t.status("a2")).toBe("todo");
    const comments = (await t.h.ctx.issues.listComments("a1", CO)).map((c) => c.body);
    expect(comments).toContain("The handover stopped this task: its time limit of 20 minutes was reached.");
  });

  it("the handover's own budget cap still stops everything and pauses the agent", async () => {
    const t = await setup();
    await handOver(t.h.ctx, CO, settings, ana, request("now", [note("a1"), note("a2")]), DAY);
    t.db.costs.push({ company_id: CO, agent_id: "agent-ana", cost_cents: 500, occurred_at: new Date(DAY.getTime() + 60_000) });
    await t.tick(new Date(DAY.getTime() + 5 * 60_000));
    expect(t.runRow()).toMatchObject({ status: "budget_stopped" });
    expect(await t.status("a2")).toBe("backlog");
  });

  it("a stuck task is retried once within its time, then fails", async () => {
    const t = await setup();
    await handOver(t.h.ctx, CO, settings, ana, request("now", [note("a1"), note("a2")]), DAY);
    await t.h.ctx.issues.update("a1", { status: "in_progress" }, CO);
    expect(await t.tick(new Date(DAY.getTime() + 61 * 60_000))).toEqual({ kind: "retry-step", attempt: 2 });
    expect(await t.status("a1")).toBe("todo");
    await t.h.ctx.issues.update("a1", { status: "in_progress" }, CO);
    await t.tick(new Date(DAY.getTime() + 123 * 60_000));
    expect(t.event("a1").outcome).toBe("failed");
    expect(await t.status("a2")).toBe("todo");
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

describe("the pre-handover check on the owner's own tasks", () => {
  const workspace = (dir: string) => ({ id: "ws-1", projectId: "proj-1", name: "repo", path: dir, repoUrl: null, repoRef: null, defaultRef: "main", isPrimary: true, createdAt: "", updatedAt: "" });
  const withRepo = async (codeowners?: string) => {
    const t = await setup();
    t.h.seed({ projects: [{ id: "proj-1", companyId: CO, name: "App" } as unknown as Project], projectWorkspaces: [workspace(repoWithOwners(codeowners))] });
    return t;
  };

  it("a task reaching into a teammate's CODEOWNERS area is not handed over; nothing changes and nothing moves", async () => {
    const t = await withRepo();
    const res = await handOver(t.h.ctx, CO, settings, ana, request("now", [note("a1", { files: "src/ui/" }), note("a2", { files: "src/api/search.ts" })]), DAY);
    expect(res).toMatchObject({ ok: false, overlaps: ['"Title a2": `src/api/search.ts` is in bo@example.com\'s area (CODEOWNERS line 2).'] });
    expect(t.db.tables.handover_runs).toHaveLength(0);
    expect(t.db.tables.handover_notes).toHaveLength(0);
    expect((await t.h.ctx.issues.get("a2", CO))?.assigneeAgentId).toBe("agent-ana");
    expect(t.db.tables.overlaps).toMatchObject([{ owner: "ana@example.com", keeper: "bo@example.com", kind: "area", claim: "src/api/search.ts", ticket_id: "a2" }]);
  });

  it("files a teammate's handed-over task holds are refused until that task is decided", async () => {
    const t = await setup();
    expect((await handOver(t.h.ctx, CO, settings, bo, request("scheduled", [note("b1", { files: "docs/" })], bo), DAY)).ok).toBe(true);
    const res = await handOver(t.h.ctx, CO, settings, ana, request("now", [note("a1", { files: "docs/guide.md" })]), DAY);
    expect(res).toMatchObject({ ok: false, overlaps: [expect.stringContaining('overlaps `docs`, which bo@example.com\'s task "Title b1" already holds')] });
    await withdrawQueued(t.h.ctx, CO, bo);
    expect((await handOver(t.h.ctx, CO, settings, ana, request("now", [note("a1", { files: "docs/guide.md" })]), DAY)).ok).toBe(true);
  });

  it("warns the owner about GitHub teams in CODEOWNERS, and never passes on a guess", async () => {
    const t = await withRepo("/src/ui/  ana@example.com\n/src/api/  @acme/backend\n");
    const res = await handOver(t.h.ctx, CO, settings, ana, request("now", [note("a1", { files: "src/api/" })]), DAY);
    expect(res).toMatchObject({ ok: true, notes: [expect.stringContaining("WARNING: CODEOWNERS names GitHub team @acme/backend (line 2).")] });
    const u = await setup();
    u.h.seed({ projects: [{ id: "proj-1", companyId: CO, name: "App" } as unknown as Project], projectWorkspaces: [workspace(path.join(tmpdir(), "vt-no-such-repo"))] });
    expect(await handOver(u.h.ctx, CO, settings, ana, request("now", [note("a1")]), DAY)).toEqual({ ok: false, message: "the project's repository could not be read for the pre-handover check" });
  });
});
