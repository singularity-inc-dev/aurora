/**
 * Bug 3: per-step time-outs and retries with backoff on every agent and network
 * step, so one slow call cannot hang a handover (or everyone else's).
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import type { Agent, Company, PluginAccessMember } from "@paperclipai/plugin-sdk";
import manifest from "../src/manifest.js";
import plugin from "../src/worker.js";
import { parseSettings } from "../src/config.js";
import { tickCompany, tickPerson } from "../src/handoverrunner.js";
import { git } from "../src/git.js";
import { exportCommit } from "../src/checks.js";
import { replayMerge } from "../src/replay.js";
import { retrying, withTimeout, TimedOut } from "../src/retry.js";
import { TOOL_PROPOSE } from "../src/tools.js";
import { PLAN_ORIGIN } from "../src/ids.js";
import { createFakeDb } from "./fakedb.js";
import { isolatedAgentFields, isolatedPersonFields } from "./helpers.js";

describe("retrying and withTimeout", () => {
  it("retries a failing step with growing pauses, then succeeds", async () => {
    const pauses: number[] = [];
    let calls = 0;
    const value = await retrying(
      async () => {
        calls += 1;
        if (calls < 3) throw new Error("flaky");
        return "ok";
      },
      { attempts: 4, baseDelayMs: 500, sleep: async (ms) => void pauses.push(ms) },
    );
    expect(value).toBe("ok");
    expect(pauses).toEqual([500, 1000]);
  });

  it("gives up after its attempts with the last error, and caps the pause", async () => {
    const pauses: number[] = [];
    await expect(
      retrying(async () => Promise.reject(new Error("down")), { attempts: 5, baseDelayMs: 1000, maxDelayMs: 3000, sleep: async (ms) => void pauses.push(ms) }),
    ).rejects.toThrow("down");
    expect(pauses).toEqual([1000, 2000, 3000, 3000]);
  });

  it("a step that never answers times out (and each attempt has its own limit)", async () => {
    const never = () => new Promise<never>(() => {});
    await expect(withTimeout(never(), 20, "slow call")).rejects.toBeInstanceOf(TimedOut);
    let calls = 0;
    await expect(retrying(() => ((calls += 1), never()), { attempts: 2, baseDelayMs: 1, timeoutMs: 20 })).rejects.toThrow("timed out");
    expect(calls).toBe(2);
  });
});

describe("git never hangs a tick", () => {
  /** Put a `git` that never answers first on PATH for the duration of `fn`. */
  async function withStuckGit<T>(fn: () => Promise<T>): Promise<T> {
    const bin = mkdtempSync(path.join(tmpdir(), "vt-stuck-git-"));
    writeFileSync(path.join(bin, "git"), "#!/bin/sh\nexec sleep 30\n", { mode: 0o755 });
    const saved = process.env.PATH;
    process.env.PATH = `${bin}:${saved}`;
    try {
      return await fn();
    } finally {
      process.env.PATH = saved;
    }
  }
  const sha = "a".repeat(40);

  it("a git command past its limit is stopped", async () => {
    const started = Date.now();
    await expect(withStuckGit(() => git(tmpdir(), ["status"], { timeoutMs: 300 }))).rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it("copying a commit for the checks gives up instead of hanging", async () => {
    const started = Date.now();
    const ok = await withStuckGit(() => exportCommit(tmpdir(), sha, mkdtempSync(path.join(tmpdir(), "vt-out-")), { timeoutMs: 300 }));
    expect(ok).toBe(false);
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it("a merge replay past its limit reports an error, not a hang", async () => {
    const started = Date.now();
    const result = await withStuckGit(() => replayMerge(tmpdir(), sha, sha, { timeoutMs: 300 }));
    expect(result.status).toBe("error");
    expect(Date.now() - started).toBeLessThan(5000);
  });
});

const CO = "co-1";
const EVENING = new Date("2026-10-21T20:30:00Z");
const NIGHT = new Date("2026-10-21T22:05:00Z");
const config = {
  night: { projectId: "proj-1", stepTimeoutMinutes: 60, maxRetries: 1 },
  people: [
    { email: "ana@example.com", agentId: "agent-ana", ...isolatedPersonFields("agent-ana"), timezone: "UTC", handoverStartHour: 22, handoverBudgetCapCents: 500, maxTasksPerHandover: 2 },
    { email: "bo@example.com", agentId: "agent-bo", ...isolatedPersonFields("agent-bo"), timezone: "UTC", handoverStartHour: 22, handoverBudgetCapCents: 500 },
  ],
};
const settings = (() => {
  const r = parseSettings(config);
  if (!r.ok) throw new Error(r.errors.join(";"));
  return r.settings;
})();
const [ana, bo] = settings.people as [(typeof settings.people)[0], (typeof settings.people)[0]];

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
  const runOf = (owner: string) => db.tables.handover_runs.find((r) => r.owner === owner)!;
  const plans = async () => (await h.ctx.issues.list({ companyId: CO })).filter((i) => i.originKind === PLAN_ORIGIN);
  return { h, db, runOf, plans };
}

/** Ana's night is running her first task. */
async function running() {
  const t = await setup();
  await tickPerson(t.h.ctx, CO, settings, ana, EVENING);
  const res = await t.h.executeTool<{ data: { planIssueId: string; taskIds: string[] } }>(TOOL_PROPOSE, { tasks: [{ title: "Fix login", claims: ["src/"] }] }, { agentId: "agent-ana", runId: "r1", companyId: CO, projectId: "proj-1" });
  const [interaction] = await t.h.ctx.issues.listInteractions(res.data.planIssueId, CO);
  await t.h.ctx.issues.respondInteraction(res.data.planIssueId, interaction!.id, { action: "accept", actorUserId: "owner-user" }, CO);
  await tickPerson(t.h.ctx, CO, settings, ana, EVENING);
  await tickPerson(t.h.ctx, CO, settings, ana, NIGHT);
  const task = res.data.taskIds[0]!;
  await t.h.ctx.issues.update(task, { status: "in_progress" }, CO);
  return { ...t, task };
}

describe("Paperclip calls in the handover", () => {
  it("a retry still wakes the agent when one call fails once", async () => {
    const t = await running();
    const update = t.h.ctx.issues.update.bind(t.h.ctx.issues);
    let failures = 1;
    t.h.ctx.issues.update = async (...args: Parameters<typeof update>) => {
      if ((args[1] as { status?: string }).status === "todo" && failures-- > 0) throw new Error("Paperclip timed out");
      return update(...args);
    };
    expect(await tickPerson(t.h.ctx, CO, settings, ana, new Date(NIGHT.getTime() + 61 * 60_000))).toEqual({ kind: "retry-step", attempt: 2 });
    expect((await t.h.ctx.issues.get(t.task, CO))?.status).toBe("todo");
  });

  it("a comment that fails never stops the agent being woken", async () => {
    const t = await running();
    t.h.ctx.issues.createComment = async () => {
      throw new Error("Paperclip is down");
    };
    await tickPerson(t.h.ctx, CO, settings, ana, new Date(NIGHT.getTime() + 61 * 60_000));
    expect((await t.h.ctx.issues.get(t.task, CO))?.status).toBe("todo");
    expect(t.runOf(ana.email).current_attempt).toBe(2);
  });
});

describe("one slow person never holds up the others", () => {
  it("a tick that hangs for one person is cut off; the others go on, and that person is skipped while it is stuck", async () => {
    const t = await setup();
    const get = t.h.ctx.agents.get.bind(t.h.ctx.agents);
    t.h.ctx.agents.get = async (id: string, companyId: string) => (id === "agent-ana" ? new Promise<never>(() => {}) : get(id, companyId));
    const started = Date.now();
    await tickCompany(t.h.ctx, CO, settings, EVENING, { personTickMs: 200 });
    expect(Date.now() - started).toBeLessThan(3000);
    expect((await t.plans()).map((p) => p.assigneeAgentId)).toEqual(["agent-bo"]);

    // Next tick: Ana's earlier tick is still stuck, so she is skipped (no second tick piles up on hers).
    let anaCalls = 0;
    t.h.ctx.agents.get = async (id: string, companyId: string) => (id === "agent-ana" ? (anaCalls++, new Promise<never>(() => {})) : get(id, companyId));
    await tickCompany(t.h.ctx, CO, settings, new Date(EVENING.getTime() + 5 * 60_000), { personTickMs: 200 });
    expect(anaCalls).toBe(0);
  });
});

describe("the planning step has a time-out and retries too", () => {
  it("an agent that never proposes is woken again on the plan ticket, once, then the plan expires as before", async () => {
    const t = await setup();
    await tickPerson(t.h.ctx, CO, settings, ana, EVENING);
    const [plan] = await t.plans();
    expect(t.runOf(ana.email)).toMatchObject({ status: "proposing", current_attempt: 1 });
    await t.h.ctx.issues.update(plan!.id, { status: "in_progress" }, CO); // the agent picked it up, then its run died

    const retry = await tickPerson(t.h.ctx, CO, settings, ana, new Date(EVENING.getTime() + 61 * 60_000));
    expect(retry).toEqual({ kind: "retry-step", attempt: 2 });
    expect((await t.h.ctx.issues.get(plan!.id, CO))?.status).toBe("todo");
    expect(t.runOf(ana.email)).toMatchObject({ status: "proposing", current_attempt: 2 });

    // Out of retries: nothing more until the plan expires at the handover start, with the existing reason.
    await t.h.ctx.issues.update(plan!.id, { status: "in_progress" }, CO);
    expect(await tickPerson(t.h.ctx, CO, settings, ana, new Date(EVENING.getTime() + 89 * 60_000))).toEqual({ kind: "none" });
    expect(await tickPerson(t.h.ctx, CO, settings, ana, NIGHT)).toEqual({ kind: "expire", reason: "no tasks were proposed before the handover started" });
  });

  it("a plan the agent already proposed is never re-woken", async () => {
    const t = await setup();
    await tickPerson(t.h.ctx, CO, settings, bo, EVENING);
    await t.h.executeTool(TOOL_PROPOSE, { tasks: [{ title: "Docs", claims: ["docs/"] }] }, { agentId: "agent-bo", runId: "r2", companyId: CO, projectId: "proj-1" });
    expect(await tickPerson(t.h.ctx, CO, settings, bo, new Date(EVENING.getTime() + 61 * 60_000))).toEqual({ kind: "none" });
  });
});
