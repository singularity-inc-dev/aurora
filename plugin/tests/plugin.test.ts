import { describe, expect, it } from "vitest";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import type { Agent, Issue, PluginExecutionWorkspaceMetadata } from "@paperclipai/plugin-sdk";
import { pluginManifestV1Schema } from "@paperclipai/shared";
import manifest from "../src/manifest.js";
import plugin, { checksDocumentKey, HANDOFF_ORIGIN } from "../src/worker.js";
import { TOOL_HANDOFF, TOOL_RUN_CHECKS } from "../src/tools.js";
import { makeRepoWithWorktree, write } from "./helpers.js";

const CO = "co-1";
const person = (email: string, agentId: string) => ({
  email,
  agentId,
  timezone: "Europe/London",
  nightStartHour: 22,
  nightBudgetCapCents: 500,
  secrets: [{ name: "github", secret: { type: "secret_ref", secretId: `sec-${agentId}` } }],
});
const config = { people: [person("ana@example.com", "agent-ana"), person("bo@example.com", "agent-bo")] };

function agent(id: string, locked = true): Agent {
  return {
    id,
    companyId: CO,
    name: id,
    role: "engineer",
    status: "idle",
    permissions: { canCreateAgents: !locked, canCreateSkills: !locked },
  } as unknown as Agent;
}

async function setup(opts: { locked?: boolean; cfg?: Record<string, unknown> } = {}) {
  // issue.documents.read lets tests read the report back; the plugin itself never reads documents.
  const capabilities = [...manifest.capabilities, "issue.documents.read" as const];
  const harness = createTestHarness({ manifest, capabilities, config: opts.cfg ?? config });
  harness.seed({ agents: [agent("agent-ana", opts.locked ?? true), agent("agent-bo", opts.locked ?? true)] });
  await plugin.definition.setup(harness.ctx);
  return harness;
}
const run = (agentId: string) => ({ agentId, runId: "run-1", companyId: CO, projectId: "proj-1" });

describe("manifest", () => {
  it("passes Paperclip's own manifest validator", () => {
    const result = pluginManifestV1Schema.safeParse(manifest);
    expect(result.success, JSON.stringify(result.error?.issues)).toBe(true);
  });
});

describe("people and route audit", () => {
  it("lists configured people without exposing secret refs", async () => {
    const h = await setup();
    const data = await h.getData<{ ok: boolean; people: Array<Record<string, unknown>> }>("people", { companyId: CO });
    expect(data.ok).toBe(true);
    expect(data.people[0]).toMatchObject({ email: "ana@example.com", maxTasksPerNight: 3 });
    expect(JSON.stringify(data)).not.toContain("sec-agent-ana");
  });

  it("route audit flags agents left with Paperclip's default permissions", async () => {
    const h = await setup({ locked: false });
    const audit = await h.getData<{ ok: boolean }>("route-audit", { companyId: CO });
    expect(audit.ok).toBe(false);
    const ok = await (await setup()).getData<{ ok: boolean }>("route-audit", { companyId: CO });
    expect(ok.ok).toBe(true);
  });

  it("validates config through onValidateConfig", async () => {
    expect(await plugin.definition.onValidateConfig!(config)).toEqual({ ok: true });
    const bad = await plugin.definition.onValidateConfig!({ people: [config.people[0], { ...config.people[0], email: "x@example.com" }] });
    expect(bad.ok).toBe(false);
  });
});

describe("handoff_to_teammate", () => {
  it("creates a board ticket for the teammate with its own worktree settings", async () => {
    const h = await setup();
    const res = await h.executeTool<{ error?: string; data: { issueId: string } }>(
      TOOL_HANDOFF,
      { toEmail: "bo@example.com", title: "Fix login", description: "Steps in the doc" },
      run("agent-ana"),
    );
    expect(res.error).toBeUndefined();
    const issue = await h.ctx.issues.get(res.data.issueId, CO);
    expect(issue).toMatchObject({ assigneeAgentId: "agent-bo", originKind: HANDOFF_ORIGIN, title: "Fix login" });
    expect(issue?.executionWorkspaceSettings).toMatchObject({
      mode: "isolated_workspace",
      workspaceStrategy: { type: "git_worktree" },
    });
  });

  it("reassigns only tickets the caller owns", async () => {
    const h = await setup();
    h.seed({
      issues: [
        { id: "iss-ana", companyId: CO, title: "mine", assigneeAgentId: "agent-ana" } as unknown as Issue,
        { id: "iss-bo", companyId: CO, title: "theirs", assigneeAgentId: "agent-bo" } as unknown as Issue,
      ],
    });
    const ok = await h.executeTool<{ error?: string }>(TOOL_HANDOFF, { toEmail: "bo@example.com", issueId: "iss-ana" }, run("agent-ana"));
    expect(ok.error).toBeUndefined();
    expect((await h.ctx.issues.get("iss-ana", CO))?.assigneeAgentId).toBe("agent-bo");
    const stolen = await h.executeTool<{ error?: string }>(TOOL_HANDOFF, { toEmail: "ana@example.com", issueId: "iss-ana" }, run("agent-bo"));
    expect(stolen.error).toBeUndefined();
    const notMine = await h.executeTool<{ error?: string }>(TOOL_HANDOFF, { toEmail: "bo@example.com", issueId: "iss-bo" }, run("agent-ana"));
    expect(notMine.error).toBe("you can only hand off tickets assigned to you");
  });

  it("refuses when either agent still has a side door", async () => {
    const h = await setup({ locked: false });
    const res = await h.executeTool<{ error?: string }>(TOOL_HANDOFF, { toEmail: "bo@example.com", title: "t" }, run("agent-ana"));
    expect(res.error).toContain("not locked down");
  });

  it("refuses when settings are invalid (fail closed)", async () => {
    const h = await setup({ cfg: { people: [person("ana@example.com", "agent-ana"), person("bo@example.com", "agent-ana")] } });
    const res = await h.executeTool<{ error?: string }>(TOOL_HANDOFF, { toEmail: "bo@example.com", title: "t" }, run("agent-ana"));
    expect(res.error).toContain("settings are invalid");
  });

  it("refuses unknown teammates and unbound agents", async () => {
    const h = await setup();
    expect((await h.executeTool<{ error?: string }>(TOOL_HANDOFF, { toEmail: "eve@example.com", title: "t" }, run("agent-ana"))).error).toContain(
      "not a configured teammate",
    );
    expect((await h.executeTool<{ error?: string }>(TOOL_HANDOFF, { toEmail: "bo@example.com", title: "t" }, run("agent-x"))).error).toContain(
      "not bound",
    );
  });
});

describe("run_checks", () => {
  async function withWorkspace(providerType = "git_worktree") {
    const h = await setup({ cfg: { ...config, checks: { testCommand: "true" } } });
    const { worktree } = makeRepoWithWorktree();
    write(worktree, "src/a.ts", "export const a = 1;\n");
    h.seed({
      executionWorkspaces: [
        { id: "ws-1", companyId: CO, projectId: "proj-1", projectWorkspaceId: null, path: worktree, cwd: worktree, repoUrl: null, baseRef: "main", branchName: "task", providerType, providerMetadata: null } as PluginExecutionWorkspaceMetadata,
      ],
      issues: [{ id: "iss-1", companyId: CO, title: "t", assigneeAgentId: "agent-ana", executionWorkspaceId: "ws-1" } as unknown as Issue],
    });
    return h;
  }

  it("runs in the ticket's worktree and attaches the report to the ticket", async () => {
    const h = await withWorkspace();
    const res = await h.executeTool<{ error?: string; data: { passed: boolean; documentKey: string } }>(TOOL_RUN_CHECKS, { issueId: "iss-1" }, run("agent-ana"));
    expect(res.error).toBeUndefined();
    expect(res.data.passed).toBe(true);
    const doc = await h.ctx.issues.documents.get("iss-1", res.data.documentKey, CO);
    expect(doc?.body).toContain("Checks gate: PASSED");
  });

  it("refuses tickets that belong to another agent", async () => {
    const h = await withWorkspace();
    const res = await h.executeTool<{ error?: string }>(TOOL_RUN_CHECKS, { issueId: "iss-1" }, run("agent-bo"));
    expect(res.error).toBe("you can only run checks on tickets assigned to you");
  });

  it("refuses a workspace that is not a git worktree (e.g. the shared checkout)", async () => {
    const h = await withWorkspace("local_fs");
    const res = await h.executeTool<{ error?: string }>(TOOL_RUN_CHECKS, { issueId: "iss-1" }, run("agent-ana"));
    expect(res.error).toBe("ticket workspace is not a git worktree");
  });
});

describe("checksDocumentKey", () => {
  it("fits Paperclip's document key rule", () => {
    const key = checksDocumentKey(new Date("2026-10-21T13:15:00.123Z"));
    expect(key).toBe("vt-checks-20261021131500123");
    expect(key).toMatch(/^[a-z0-9][a-z0-9_-]*$/);
    expect(key.length).toBeLessThanOrEqual(64);
  });
});
