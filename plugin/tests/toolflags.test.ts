import { describe, expect, it } from "vitest";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import type { Agent, Issue } from "@paperclipai/plugin-sdk";
import manifest from "../src/manifest.js";
import plugin from "../src/worker.js";
import { TOOL_HANDOFF, TOOL_RUN_CHECKS } from "../src/tools.js";
import { createFakeDb } from "./fakedb.js";
import { isolatedAgentFields, isolatedPersonFields } from "./helpers.js";

const CO = "co-1";
const person = (email: string, agentId: string) => ({ email, agentId, ...isolatedPersonFields(agentId), timezone: "UTC", handoverStartHour: 22, handoverBudgetCapCents: 500 });
const config = { isolation: { required: false }, people: [person("ana@example.com", "agent-ana"), person("bo@example.com", "agent-bo")] };
const agent = (id: string) => ({ ...isolatedAgentFields(id), id, companyId: CO, name: id, role: "engineer", status: "idle", permissions: { canCreateAgents: false, canCreateSkills: false } }) as unknown as Agent;
const run = (agentId: string) => ({ agentId, runId: "run-1", companyId: CO, projectId: "proj-1" });

async function setup() {
  const h = createTestHarness({ manifest, capabilities: [...manifest.capabilities], config });
  const db = createFakeDb();
  (h.ctx as { db: unknown }).db = db;
  h.seed({
    agents: [agent("agent-ana"), agent("agent-bo")],
    issues: [
      { id: "iss-ana", companyId: CO, title: "mine", assigneeAgentId: "agent-ana", status: "todo" } as unknown as Issue,
      { id: "iss-bo", companyId: CO, title: "theirs", assigneeAgentId: "agent-bo", status: "todo" } as unknown as Issue,
    ],
  });
  await plugin.definition.setup(h.ctx);
  return { h, db };
}

describe("run flag: tool error", () => {
  it("a failed run_checks puts a tool-error flag on the agent's own ticket, with the refusal text", async () => {
    const { h, db } = await setup();
    const res = await h.executeTool<{ error?: string }>(TOOL_RUN_CHECKS, { issueId: "iss-ana" }, run("agent-ana"));
    expect(res.error).toBe("ticket has no isolated worktree yet");
    expect(db.tables.run_flags).toMatchObject([{ task_id: "iss-ana", company_id: CO, kind: "tool-error", detail: `${TOOL_RUN_CHECKS}: ticket has no isolated worktree yet` }]);
  });

  it("an agent cannot put a flag on a teammate's task by calling a tool on it", async () => {
    const { h, db } = await setup();
    const res = await h.executeTool<{ error?: string }>(TOOL_RUN_CHECKS, { issueId: "iss-bo" }, run("agent-ana"));
    expect(res.error).toBe("you can only run checks on tickets assigned to you");
    expect(db.tables.run_flags).toEqual([]);
    const handoff = await h.executeTool<{ error?: string }>(TOOL_HANDOFF, { toEmail: "bo@example.com", issueId: "iss-bo" }, run("agent-ana"));
    expect(handoff.error).toBe("you can only hand off tickets assigned to you");
    expect(db.tables.run_flags).toEqual([]);
  });

  it("a failed hand-off of the agent's own ticket is flagged; a call with no ticket cannot be", async () => {
    const { h, db } = await setup();
    const res = await h.executeTool<{ error?: string }>(TOOL_HANDOFF, { toEmail: "nobody@example.com", issueId: "iss-ana" }, run("agent-ana"));
    expect(res.error).toBeTruthy();
    expect(db.tables.run_flags).toMatchObject([{ task_id: "iss-ana", kind: "tool-error" }]);
    db.tables.run_flags.length = 0;
    await h.executeTool(TOOL_HANDOFF, { toEmail: "nobody@example.com", title: "x" }, run("agent-ana"));
    expect(db.tables.run_flags).toEqual([]);
  });

  it("a tool call that works leaves no flag", async () => {
    const { h, db } = await setup();
    const ok = await h.executeTool<{ error?: string }>(TOOL_HANDOFF, { toEmail: "bo@example.com", issueId: "iss-ana" }, run("agent-ana"));
    expect(ok.error).toBeUndefined();
    expect(db.tables.run_flags).toEqual([]);
  });
});
