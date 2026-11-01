import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ensureTaskRow, recordChecks } from "../src/eventlog.js";
import { MAX_SAVE, ownerTag, saveReplayTasks } from "../src/replaysave.js";
import type { ChecksSettings } from "../src/config.js";
import { createFakeDb } from "./fakedb.js";
import { fakeGithubToken } from "./helpers.js";

const BASE = "a".repeat(40);
const HEAD = "b".repeat(40);
const CHECKS: ChecksSettings = { testCommand: "pnpm test", lintCommand: null, maxDiffLines: 400, timeoutSeconds: 120, sandbox: null };

interface Ticket {
  title: string;
  description: string | null;
  identifier?: string | null;
  descriptionTruncated?: boolean;
  executionWorkspaceId?: string | null;
}

function setup() {
  const db = createFakeDb();
  const tickets = new Map<string, Ticket>();
  const ctx = {
    db,
    issues: {
      get: async (id: string) => {
        const t = tickets.get(id);
        return t ? { id, identifier: null, executionWorkspaceId: "ws1", ...t } : null;
      },
    },
    executionWorkspaces: { get: async () => ({ baseRef: "main", repoUrl: "git@example.com:acme/app.git" }) },
  };
  /** A task as the live system leaves it: a row, a checks result with both commits, and an outcome. */
  async function task(id: string, opts: { outcome?: string | null; base?: string | null; head?: string | null; finished?: string; owner?: string; ticket?: Ticket | null } = {}) {
    await ensureTaskRow(db, { taskId: id, companyId: "co", owner: opts.owner ?? "ana@example.com", agent: "a1", taskKind: "task" });
    if (opts.head !== null) await recordChecks(db, id, "passed", opts.head ?? HEAD, opts.base === undefined ? BASE : opts.base);
    const row = db.tables.task_events.find((r) => r.task_id === id)!;
    row.outcome = opts.outcome === undefined ? "accepted" : opts.outcome;
    row.started_at = "2026-10-30T22:00:00.000Z";
    row.finished_at = opts.finished ?? "2026-10-30T22:10:00.000Z";
    if (opts.ticket !== null) tickets.set(id, opts.ticket ?? { title: `Title ${id}`, description: `Do ${id}`, identifier: `VT-${id}` });
  }
  return { ctx: ctx as unknown as Parameters<typeof saveReplayTasks>[0], db, tickets, task };
}

const opts = { limit: 20, includeUndecided: false };

describe("saving real tasks for the replay", () => {
  it("saves inputs, both commits and what became of the task", async () => {
    const t = setup();
    await t.task("t1");
    const r = await saveReplayTasks(t.ctx, "co", CHECKS, opts);
    expect(r.added).toBe(1);
    expect(r.skipped).toEqual([]);
    expect(r.tasks[0]).toMatchObject({
      taskId: "t1",
      identifier: "VT-t1",
      title: "Title t1",
      description: "Do t1",
      baseRef: "main",
      baseSha: BASE,
      headSha: HEAD,
      checksResult: "passed",
      outcome: "accepted",
      durationSeconds: 600,
      inputsRedacted: false,
      descriptionTruncated: false,
    });
  });

  it("never hands out an owner's email: owners are short tags", async () => {
    const t = setup();
    await t.task("t1", { owner: "ana@example.com" });
    const r = await saveReplayTasks(t.ctx, "co", CHECKS, opts);
    expect(r.tasks[0]!.owner).toBe(ownerTag("ana@example.com"));
    expect(JSON.stringify(r)).not.toContain("ana@example.com");
    expect(ownerTag("ANA@example.com")).toBe(ownerTag("ana@example.com"));
    expect(ownerTag("bo@example.com")).not.toBe(ownerTag("ana@example.com"));
  });

  it("returns the gate's settings so the replay uses the same checks as production", async () => {
    const t = setup();
    expect((await saveReplayTasks(t.ctx, "co", CHECKS, opts)).checks).toEqual({ testCommand: "pnpm test", lintCommand: null, maxDiffLines: 400, timeoutSeconds: 120 });
  });

  it("skips tasks with no starting commit (checked before this feature existed, or never checked)", async () => {
    const t = setup();
    await t.task("old", { base: null });
    await t.task("never", { head: null });
    const r = await saveReplayTasks(t.ctx, "co", CHECKS, opts);
    expect(r.tasks).toEqual([]);
    expect(t.db.tables.saved_tasks).toHaveLength(0);
  });

  it("leaves out undecided tasks unless asked: they have no outcome to compare with", async () => {
    const t = setup();
    await t.task("open", { outcome: null });
    expect((await saveReplayTasks(t.ctx, "co", CHECKS, opts)).tasks).toEqual([]);
    const all = await saveReplayTasks(t.ctx, "co", CHECKS, { ...opts, includeUndecided: true });
    expect(all.tasks.map((x) => x.taskId)).toEqual(["open"]);
    expect(all.tasks[0]!.outcome).toBeNull();
  });

  it("keeps rejected, blocked and failed tasks: they are real outcomes too", async () => {
    const t = setup();
    for (const [i, outcome] of ["rejected", "blocked", "failed"].entries()) await t.task(`t${i}`, { outcome });
    const r = await saveReplayTasks(t.ctx, "co", CHECKS, opts);
    expect(r.tasks.map((x) => x.outcome).sort()).toEqual(["blocked", "failed", "rejected"]);
  });

  it("skips a task whose ticket is gone and says why, without naming any ticket text", async () => {
    const t = setup();
    await t.task("gone", { ticket: null });
    const r = await saveReplayTasks(t.ctx, "co", CHECKS, opts);
    expect(r.skipped).toEqual([{ taskId: "gone", reason: "the ticket is gone, so its inputs are lost" }]);
    expect(r.added).toBe(0);
  });

  it("skips a recorded commit that is not a full commit id (it would not be safe to hand to git)", async () => {
    const t = setup();
    await t.task("odd", { base: "--upload-pack=evil" });
    const r = await saveReplayTasks(t.ctx, "co", CHECKS, opts);
    expect(r.skipped[0]).toMatchObject({ taskId: "odd" });
    expect(t.db.tables.saved_tasks).toHaveLength(0);
  });

  it("replaces a secret pasted into a ticket and says so", async () => {
    const t = setup();
    const token = fakeGithubToken();
    await t.task("leak", { ticket: { title: "Fix login", description: `use token ${token} for the call` } });
    const r = await saveReplayTasks(t.ctx, "co", CHECKS, opts);
    expect(r.tasks[0]!.inputsRedacted).toBe(true);
    expect(r.tasks[0]!.description).toContain("[redacted:github-token]");
    expect(JSON.stringify(r)).not.toContain(token);
    expect(JSON.stringify(t.db.tables.saved_tasks)).not.toContain(token);
  });

  it("records that Paperclip returned only part of the ticket text", async () => {
    const t = setup();
    await t.task("long", { ticket: { title: "Big", description: "start...", descriptionTruncated: true } });
    expect((await saveReplayTasks(t.ctx, "co", CHECKS, opts)).tasks[0]!.descriptionTruncated).toBe(true);
  });

  it("saves a ticket with no description as an empty string", async () => {
    const t = setup();
    await t.task("bare", { ticket: { title: "Just a title", description: null } });
    expect((await saveReplayTasks(t.ctx, "co", CHECKS, opts)).tasks[0]!.description).toBe("");
  });

  it("is repeatable and a saved task never changes, even when the ticket is edited afterwards", async () => {
    const t = setup();
    await t.task("t1");
    await saveReplayTasks(t.ctx, "co", CHECKS, opts);
    t.tickets.set("t1", { title: "Edited later", description: "something else entirely" });
    const again = await saveReplayTasks(t.ctx, "co", CHECKS, opts);
    expect(again.added).toBe(0);
    expect(again.tasks).toHaveLength(1);
    expect(again.tasks[0]).toMatchObject({ title: "Title t1", description: "Do t1" });
  });

  it("returns the newest tasks first and at most the limit", async () => {
    const t = setup();
    await t.task("old", { finished: "2026-10-01T10:00:00.000Z" });
    await t.task("mid", { finished: "2026-10-15T10:00:00.000Z" });
    await t.task("new", { finished: "2026-10-30T10:00:00.000Z" });
    const r = await saveReplayTasks(t.ctx, "co", CHECKS, { ...opts, limit: 2 });
    expect(r.tasks.map((x) => x.taskId)).toEqual(["new", "mid"]);
  });

  it("only looks at its own company", async () => {
    const t = setup();
    await t.task("t1");
    expect((await saveReplayTasks(t.ctx, "other-company", CHECKS, opts)).tasks).toEqual([]);
  });

  it("clamps the limit to something sane", async () => {
    const t = setup();
    for (let i = 0; i < 3; i += 1) await t.task(`t${i}`);
    expect((await saveReplayTasks(t.ctx, "co", CHECKS, { ...opts, limit: 0 })).tasks).toHaveLength(1);
    expect((await saveReplayTasks(t.ctx, "co", CHECKS, { ...opts, limit: 1e9 })).tasks).toHaveLength(3);
    expect(MAX_SAVE).toBe(100);
  });
});

describe("the event log keeps the starting commit", () => {
  it("recordChecks stores the base next to the head, and the base is optional", async () => {
    const db = createFakeDb();
    await ensureTaskRow(db, { taskId: "t1", companyId: "co", owner: "a@example.com", agent: "a", taskKind: "task" });
    await recordChecks(db, "t1", "passed", HEAD, BASE);
    expect(db.tables.task_events[0]).toMatchObject({ checks_result: "passed", checks_head: HEAD, checks_base: BASE });
    await recordChecks(db, "t1", "failed", HEAD);
    expect(db.tables.task_events[0]).toMatchObject({ checks_result: "failed", checks_base: null });
  });

  it("migration 011 adds checks_base and the saved_tasks table in this plugin's namespace", () => {
    const sql = readFileSync(new URL("../migrations/011_replay.sql", import.meta.url), "utf8");
    expect(sql).toContain("checks_base");
    expect(sql).toContain("saved_tasks");
    const schemas = new Set([...sql.matchAll(/"([a-z0-9_]+)"\./g)].map((m) => m[1]));
    expect(schemas).toEqual(new Set(["plugin_vision_and_tom_d7896c8063"]));
    // Everything the code writes exists in the table.
    for (const col of ["task_id", "owner", "title", "description", "inputs_redacted", "description_truncated", "base_sha", "head_sha", "checks_result", "outcome", "started_at", "finished_at"]) {
      expect(sql).toContain(col);
    }
  });
});

describe("the replay-save route (through the real worker)", () => {
  const CO = "co-1";
  async function worker() {
    const { createTestHarness } = await import("@paperclipai/plugin-sdk/testing");
    const manifest = (await import("../src/manifest.js")).default;
    const plugin = (await import("../src/worker.js")).default;
    const config = {
      people: [{ email: "ana@example.com", agentId: "agent-ana", timezone: "UTC", handoverStartHour: 22, handoverBudgetCapCents: 500 }],
      checks: { testCommand: "pnpm test", maxDiffLines: 123, timeoutSeconds: 45 },
    };
    const h = createTestHarness({ manifest, config });
    const db = createFakeDb();
    (h.ctx as { db: unknown }).db = db;
    h.seed({
      executionWorkspaces: [{ id: "ws1", companyId: CO, projectId: "p", projectWorkspaceId: null, path: "/w", cwd: "/w", repoUrl: null, baseRef: "main", branchName: "task", providerType: "git_worktree" } as never],
      issues: [{ id: "t1", companyId: CO, identifier: "VT-1", title: "Add greeting", description: "Say hello in README. Done when README has hello.", status: "done", assigneeAgentId: "agent-ana", executionWorkspaceId: "ws1" } as never],
    });
    await plugin.definition.setup(h.ctx);
    db.tables.task_events.push({ task_id: "t1", company_id: CO, owner: "ana@example.com", agent: "agent-ana", task_kind: "task", started_at: "2026-10-21T22:05:00Z", finished_at: "2026-10-21T22:25:00Z", checks_result: "passed", checks_head: HEAD, checks_base: BASE, outcome: "accepted" });
    const call = (routeKey: string, body: Record<string, unknown> = {}) =>
      plugin.definition.onApiRequest!({ routeKey, method: "POST", path: "", params: {}, query: {}, body, actor: { actorType: "user", actorId: "board" }, companyId: CO, headers: {} } as never) as Promise<{ status: number; body: Record<string, any> }>;
    return { call, db };
  }

  it("is a board-only route", async () => {
    const manifest = (await import("../src/manifest.js")).default;
    const route = manifest.apiRoutes!.find((r) => r.routeKey === "replay-save")!;
    expect(route).toMatchObject({ method: "POST", auth: "board", companyResolution: { from: "body", key: "companyId" } });
  });

  it("saves the task with its inputs and commits, and returns the gate settings", async () => {
    const { call, db } = await worker();
    const r = await call("replay-save", { limit: 10 });
    expect(r.status).toBe(200);
    expect(r.body.added).toBe(1);
    expect(r.body.tasks[0]).toMatchObject({ taskId: "t1", identifier: "VT-1", title: "Add greeting", baseSha: BASE, headSha: HEAD, outcome: "accepted", durationSeconds: 1200, baseRef: "main" });
    expect(r.body.tasks[0].description).toContain("Done when README has hello");
    expect(r.body.checks).toEqual({ testCommand: "pnpm test", lintCommand: null, maxDiffLines: 123, timeoutSeconds: 45 });
    expect(db.tables.saved_tasks).toHaveLength(1);
  });

  it("does nothing with a nonsense limit and still answers", async () => {
    const { call } = await worker();
    const r = await call("replay-save", { limit: "lots" });
    expect(r.status).toBe(200);
    expect(r.body.tasks).toHaveLength(1);
  });
});
