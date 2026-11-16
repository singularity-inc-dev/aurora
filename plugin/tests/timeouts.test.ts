/**
 * Bug 3: per-step time-outs and retries with backoff on every agent and network
 * step, so one slow call cannot hang a handover (or everyone else's).
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import type { Agent, Company, Issue, PluginAccessMember } from "@paperclipai/plugin-sdk";
import manifest from "../src/manifest.js";
import plugin from "../src/worker.js";
import { parseSettings } from "../src/config.js";
import { handOver, parseHandoverRequest, tickCompany, tickPerson } from "../src/handoverrunner.js";
import { git } from "../src/git.js";
import { exportCommit } from "../src/checks.js";
import { replayMerge } from "../src/replay.js";
import { retrying, withTimeout, TimedOut } from "../src/retry.js";
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

const ticket = (id: string, assignee: string) =>
  ({ id, companyId: CO, identifier: id.toUpperCase(), title: `Title ${id}`, description: `Description ${id}`, status: "backlog", assigneeAgentId: assignee, projectId: "proj-1" }) as unknown as Issue;
const request = (when: "now" | "scheduled", issueId: string, who = ana, files = "src/") => {
  const r = parseHandoverRequest({ when, tasks: [{ issueId, what: `Do ${issueId}`, doneWhen: "it works", files }] }, settings, who);
  if (typeof r === "string") throw new Error(r);
  return r;
};

async function setup() {
  const h = createTestHarness({ manifest, config });
  const db = createFakeDb();
  (h.ctx as { db: unknown }).db = db;
  const agent = (id: string) => ({ ...isolatedAgentFields(id), id, companyId: CO, name: id, role: "engineer", status: "idle", permissions: { canCreateAgents: false, canCreateSkills: false } }) as unknown as Agent;
  h.seed({
    companies: [{ id: CO, name: "Co" } as unknown as Company],
    agents: [agent("agent-ana"), agent("agent-bo")],
    issues: [ticket("a1", "agent-ana"), ticket("b1", "agent-bo")],
    accessMembers: [{ id: "m1", companyId: CO, principalType: "user", principalId: "owner-user", status: "active", membershipRole: "owner", grants: [], createdAt: "", updatedAt: "" } as unknown as PluginAccessMember],
  });
  await plugin.definition.setup(h.ctx);
  const runOf = (owner: string) => db.tables.handover_runs.find((r) => r.owner === owner)!;
  return { h, db, runOf };
}

/** Ana's handover is running her first task (PR #12: she handed it over herself; the tap was the approval). */
async function running() {
  const t = await setup();
  const res = await handOver(t.h.ctx, CO, settings, ana, request("now", "a1"), NIGHT);
  if (!res.ok) throw new Error(res.message);
  await tickPerson(t.h.ctx, CO, settings, ana, NIGHT);
  const task = "a1";
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
    // Both owners queued a ticket for their scheduled handover (PR #12); the scheduled start checks each agent first.
    expect((await handOver(t.h.ctx, CO, settings, ana, request("scheduled", "a1"), EVENING)).ok).toBe(true);
    expect((await handOver(t.h.ctx, CO, settings, bo, request("scheduled", "b1", bo, "docs/"), EVENING)).ok).toBe(true);
    const get = t.h.ctx.agents.get.bind(t.h.ctx.agents);
    t.h.ctx.agents.get = async (id: string, companyId: string) => (id === "agent-ana" ? new Promise<never>(() => {}) : get(id, companyId));
    const started = Date.now();
    await tickCompany(t.h.ctx, CO, settings, NIGHT, { personTickMs: 200 });
    expect(Date.now() - started).toBeLessThan(3000);
    expect(t.db.tables.handover_runs.map((r) => r.owner)).toEqual(["bo@example.com"]);

    // Next tick: Ana's earlier tick is still stuck, so she is skipped (no second tick piles up on hers).
    let anaCalls = 0;
    t.h.ctx.agents.get = async (id: string, companyId: string) => (id === "agent-ana" ? (anaCalls++, new Promise<never>(() => {})) : get(id, companyId));
    await tickCompany(t.h.ctx, CO, settings, new Date(NIGHT.getTime() + 5 * 60_000), { personTickMs: 200 });
    expect(anaCalls).toBe(0);
  });
});
