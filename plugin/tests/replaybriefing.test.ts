import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import type { Company, Issue, PluginExecutionWorkspaceMetadata } from "@paperclipai/plugin-sdk";
import manifest from "../src/manifest.js";
import { createBriefing, renderBriefing } from "../src/briefing.js";
import { CONFLICT_NOTICE_PREFIX, type Briefing } from "../src/briefstore.js";
import { parseSettings, type Person } from "../src/config.js";
import { createFakeDb } from "./fakedb.js";

const CO = "co-1";
const NOW = new Date("2026-10-24T07:00:00Z");
const settings = (() => {
  const r = parseSettings({
    links: { baseUrl: "https://vt.example.com/vt", signingSecret: { type: "secret_ref", secretId: "sign" } },
    isolation: { required: false },
    people: [
      { email: "ana@example.com", agentId: "agent-ana", timezone: "UTC", handoverStartHour: 22, handoverBudgetCapCents: 500 },
      { email: "bo@example.com", agentId: "agent-bo", timezone: "UTC", handoverStartHour: 22, handoverBudgetCapCents: 500 },
    ],
  });
  if (!r.ok) throw new Error(r.errors.join(";"));
  return r.settings;
})();
const [ana, bo] = settings.people as [Person, Person];

const LONG = Array.from({ length: 10 }, (_, i) => `line ${i + 1}`);

/** A repository with one worktree per task branch, as Paperclip makes them. */
function repo() {
  const dir = mkdtempSync(path.join(tmpdir(), "vt-replay-brief-"));
  const g = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, stdio: "pipe" }).toString().trim();
  g(dir, "init", "-q", "-b", "main");
  g(dir, "config", "user.email", "t@example.com");
  g(dir, "config", "user.name", "t");
  writeFileSync(path.join(dir, "greeting.txt"), "hello\n");
  writeFileSync(path.join(dir, "long.txt"), LONG.join("\n") + "\n");
  g(dir, "add", ".");
  g(dir, "commit", "-qm", "base");
  const task = (name: string, file: string, content: string) => {
    const wt = path.join(dir, "..", `${path.basename(dir)}-${name}`);
    g(dir, "worktree", "add", "-q", "-b", `vt/${name}`, wt, "main");
    writeFileSync(path.join(wt, file), content);
    g(wt, "add", ".");
    g(wt, "commit", "-qm", name);
    return { wt, head: g(wt, "rev-parse", "HEAD"), branch: `vt/${name}` };
  };
  return { task };
}

async function setup() {
  const h = createTestHarness({ manifest, capabilities: [...manifest.capabilities], config: {} });
  const db = createFakeDb();
  (h.ctx as { db: unknown }).db = db;
  h.seed({ companies: [{ id: CO, name: "Co" } as unknown as Company] });
  const r = repo();
  /** A finished task with passing checks on its branch head, owned by `owner`. */
  const ready = async (id: string, owner: Person, file: string, content: string) => {
    const t = r.task(id, file, content);
    h.seed({
      issues: [{ id, companyId: CO, identifier: id.toUpperCase(), title: `Task ${id}`, status: "done", assigneeAgentId: owner.agentId, executionWorkspaceId: `ew-${id}` } as unknown as Issue],
      executionWorkspaces: [
        { id: `ew-${id}`, companyId: CO, projectId: "p", projectWorkspaceId: null, path: t.wt, cwd: t.wt, repoUrl: null, baseRef: "main", branchName: t.branch, providerType: "git_worktree", providerMetadata: null } as PluginExecutionWorkspaceMetadata,
      ],
    });
    db.tables.task_events.push({ task_id: id, company_id: CO, owner: owner.email, agent: owner.agentId, task_kind: "task", started_at: NOW.toISOString(), checks_result: "passed", checks_head: t.head, outcome: null, decision_action_id: null });
  };
  const brief = (p: Person, key: string, taskIds: string[], carried: string[] = []) =>
    createBriefing(h.ctx, p, settings.links!, CO, key, taskIds.length ? ({ taskIds, status: "finished" } as never) : null, carried, NOW, settings.people);
  return { db, ready, brief };
}

describe("merge replay at handback", () => {
  it("lists a conflict with another owner's ready work and tells that owner once", async () => {
    const t = await setup();
    await t.ready("b1", bo, "greeting.txt", "hi from Bo\n");
    // Bo's handback goes first: nothing to conflict with yet.
    const boFirst = await t.brief(bo, "2026-10-23", ["b1"]);
    expect(boFirst!.conflicts).toEqual([]);

    await t.ready("a1", ana, "greeting.txt", "hi from Ana\n");
    await t.ready("a2", ana, "other.txt", "new\n");
    const anas = await t.brief(ana, "2026-10-24", ["a1", "a2"]);
    expect(anas!.conflicts).toEqual([
      { taskId: "a1", title: "Task a1", identifier: "A1", withOwner: "bo@example.com", withTaskId: "b1", withTitle: "Task b1", withIdentifier: "B1", files: ["greeting.txt"] },
    ]);
    expect(t.db.tables.conflicts).toMatchObject([{ task_a: "a1", task_b: "b1", owner_a: "ana@example.com", owner_b: "bo@example.com", files: '["greeting.txt"]' }]);

    // Bo's task was already handed back, so Bo gets a short notice with fresh links.
    const notices = t.db.tables.briefings.filter((b) => String(b.handover_key).startsWith(CONFLICT_NOTICE_PREFIX));
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({ owner: "bo@example.com" });
    expect(JSON.parse(String(notices[0]!.conflicts))).toMatchObject([{ taskId: "b1", withOwner: "ana@example.com", withTaskId: "a1" }]);
    expect(JSON.parse(String(notices[0]!.items))).toMatchObject([{ taskId: "b1", category: "ready" }]);

    // Nothing was merged or approved: the decisions stay with the owners.
    expect(t.db.tables.task_events.every((r) => r.outcome == null)).toBe(true);

    // Found again in a later email: still listed, but nobody is told twice.
    await t.brief(ana, "2026-10-25", [], ["a1"]);
    expect(t.db.tables.briefings.filter((b) => String(b.handover_key).startsWith(CONFLICT_NOTICE_PREFIX))).toHaveLength(1);
    expect(JSON.parse(String(t.db.tables.briefings.at(-1)!.conflicts))).toHaveLength(1);
  });

  it("does not send a notice for work not yet handed back (its own email will show it)", async () => {
    const t = await setup();
    await t.ready("b1", bo, "greeting.txt", "hi from Bo\n");
    await t.ready("a1", ana, "greeting.txt", "hi from Ana\n");
    const anas = await t.brief(ana, "2026-10-24", ["a1"]);
    expect(anas!.conflicts).toHaveLength(1);
    expect(t.db.tables.briefings).toHaveLength(1);
    const bos = await t.brief(bo, "2026-10-24", ["b1"]);
    expect(bos!.conflicts).toMatchObject([{ taskId: "b1", withOwner: "ana@example.com" }]);
  });

  it("lists a file both owners changed even when git merges it cleanly, and announces nothing", async () => {
    const t = await setup();
    await t.ready("b1", bo, "long.txt", [...LONG.slice(0, 9), "BO"].join("\n") + "\n");
    await t.ready("a1", ana, "long.txt", ["ANA", ...LONG.slice(1)].join("\n") + "\n");
    const anas = await t.brief(ana, "2026-10-24", ["a1"]);
    expect(anas!.conflicts).toEqual([]);
    expect(anas!.shared).toEqual([
      { taskId: "a1", title: "Task a1", identifier: "A1", withOwner: "bo@example.com", withTaskId: "b1", withTitle: "Task b1", withIdentifier: "B1", files: ["long.txt"] },
    ]);
    expect(JSON.parse(String(t.db.tables.briefings.at(-1)!.shared_files))).toHaveLength(1);
    // Not a conflict: nothing recorded as one, no notice to Bo, nothing merged.
    expect(t.db.tables.conflicts).toEqual([]);
    expect(t.db.tables.briefings).toHaveLength(1);
    expect(t.db.tables.task_events.every((r) => r.outcome == null)).toBe(true);
  });

  it("also replays an owner's own ready branches against each other", async () => {
    const t = await setup();
    await t.ready("a1", ana, "greeting.txt", "one\n");
    await t.ready("a2", ana, "greeting.txt", "two\n");
    const anas = await t.brief(ana, "2026-10-24", ["a1", "a2"]);
    expect(anas!.conflicts).toMatchObject([{ taskId: "a1", withTaskId: "a2", withOwner: "ana@example.com" }]);
    expect(t.db.tables.briefings).toHaveLength(1);
  });
});

describe("conflicts in the email", () => {
  const base: Briefing = {
    id: "b1",
    companyId: CO,
    owner: "ana@example.com",
    handoverKey: "2026-10-24",
    status: "pending",
    notes: [],
    items: [{ taskId: "a1", identifier: "A1", title: "Greeting", category: "ready", summary: "Greeting: 1 file changed", checks: "checks passed", reason: null, approveActionId: "x1", rejectActionId: "x2" }],
    conflicts: [{ taskId: "a1", title: "Greeting", identifier: "A1", withOwner: "bo@example.com", withTaskId: "b1", withTitle: "Banner", withIdentifier: "B1", files: ["greeting.txt"] }],
  };
  const render = (b: Briefing) => renderBriefing(b, settings.links!, "s".repeat(32), new Date("2026-10-25T07:00:00Z"));

  it("counts conflicts in the subject and explains them to both owners, with Approve still the owner's choice", () => {
    const e = render(base);
    expect(e.subject).toBe("Your handover of 2026-10-24: 1 ready, 0 blocked, 0 failed, 1 conflict");
    expect(e.text).toContain("CONFLICTS FOUND BY THE MERGE REPLAY (1)");
    expect(e.text).toContain('- Your "Greeting" (A1) and bo@example.com\'s "Banner" (B1) both change greeting.txt.');
    expect(e.text).toContain("Nothing has been merged. Agree with bo@example.com which goes first");
    expect(e.text).toContain("  Approve: https://vt.example.com/vt/l/");
    expect(e.html).toContain("<h2>Conflicts found by the merge replay (1)</h2>");
  });

  it("a notice says a teammate's work conflicts", () => {
    const e = render({ ...base, owner: "bo@example.com", handoverKey: `${CONFLICT_NOTICE_PREFIX}2026-10-24T07:00:00` });
    expect(e.subject).toBe("A teammate's new work conflicts with yours (1): 1 ready for your decision");
    expect(e.text.split("\n")[0]).toBe("Aurora test-merged a teammate's new work with yours and found a conflict. Your tasks below are still waiting for your decision.");
  });

  it("lists files also changed in other ready work, even with no conflict; the subject counts only conflicts", () => {
    const e = render({ ...base, conflicts: [], shared: [{ ...base.conflicts[0]!, files: ["src/app.ts", "README.md"] }] });
    expect(e.subject).toBe("Your handover of 2026-10-24: 1 ready, 0 blocked, 0 failed");
    expect(e.text).toContain("ALSO CHANGED IN OTHER READY WORK, NO CONFLICT (1)");
    expect(e.text).toContain('- Your "Greeting" (A1) and bo@example.com\'s "Banner" (B1) both change src/app.ts, README.md.');
    expect(e.text).toContain("Git merges them cleanly, but nothing has checked that they still work together.");
    expect(e.html).toContain("<h2>Also changed in other ready work, no conflict (1)</h2>");
  });

  it("emails without conflicts look as before", () => {
    const e = render({ ...base, conflicts: [] });
    expect(e.subject).toBe("Your handover of 2026-10-24: 1 ready, 0 blocked, 0 failed");
    expect(e.text).not.toContain("CONFLICTS");
  });
});
