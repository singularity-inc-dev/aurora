import { definePlugin, runWorker, type PluginContext, type ToolResult } from "@paperclipai/plugin-sdk";
import { runChecksGate, formatReport } from "./checks.js";
import { findPersonByAgent, parseSettings, type PluginSettings } from "./config.js";
import { ensureTaskRow, getTaskRow, recordChecks, recordHandoff } from "./eventlog.js";
import { handoffDescription, HandoffRefused, parseHandoffRequest, planHandoff } from "./handoff.js";
import { auditAgentRoutes } from "./routes.js";
import { HANDOFF_TOOL, RUN_CHECKS_TOOL, TOOL_HANDOFF, TOOL_RUN_CHECKS } from "./tools.js";
import { taskWorkspaceSettings } from "./workspace.js";

export const PLUGIN_ID = "vision-and-tom.night-agents";
export const HANDOFF_ORIGIN = `plugin:${PLUGIN_ID}:handoff` as const;
export const CHECKS_DOCUMENT_PREFIX = "vt-checks-";

/**
 * Paperclip 2026.1012.0 lets plugins create issue documents but not update them
 * (its plugin upsert sends no baseRevisionId), so every run gets its own document.
 */
export function checksDocumentKey(now: Date = new Date()): string {
  return CHECKS_DOCUMENT_PREFIX + now.toISOString().replace(/\D/g, "").slice(0, 17);
}

class Refused extends Error {}

/** Every feature goes through this: invalid settings mean the plugin does nothing. */
async function loadSettings(ctx: PluginContext, companyId: string): Promise<PluginSettings> {
  const parsed = parseSettings(await ctx.config.get(companyId));
  if (!parsed.ok) throw new Refused("plugin settings are invalid; the owner should press Test in the plugin settings");
  return parsed.settings;
}

async function requireSafeAgent(ctx: PluginContext, agentId: string, companyId: string, who: string): Promise<void> {
  const problems = auditAgentRoutes(await ctx.agents.get(agentId, companyId), companyId);
  if (problems.length > 0) throw new Refused(`${who} agent is not locked down: ${problems.join("; ")}`);
}

function refusal(err: unknown): ToolResult {
  if (err instanceof Refused || err instanceof HandoffRefused) return { error: err.message };
  throw err;
}

const plugin = definePlugin({
  async setup(ctx) {
    // Read-only summary of who is configured. Secret refs are left out on purpose.
    ctx.data.register("people", async (params) => {
      const companyId = typeof params.companyId === "string" ? params.companyId : undefined;
      const parsed = parseSettings(await ctx.config.get(companyId));
      if (!parsed.ok) return { ok: false, errors: parsed.errors };
      return {
        ok: true,
        people: parsed.settings.people.map((p) => ({
          email: p.email,
          agentId: p.agentId,
          timezone: p.timezone,
          nightStartHour: p.nightStartHour,
          maxTasksPerNight: p.maxTasksPerNight,
          nightBudgetCapCents: p.nightBudgetCapCents,
          keyNames: p.secrets.map((s) => ({ name: s.name, access: s.access })),
        })),
      };
    });

    // Which bound agents still have a side door around the board.
    ctx.data.register("route-audit", async (params) => {
      const companyId = typeof params.companyId === "string" ? params.companyId : "";
      const parsed = parseSettings(await ctx.config.get(companyId));
      if (!parsed.ok) return { ok: false, errors: parsed.errors };
      const agents = await Promise.all(
        parsed.settings.people.map(async (p) => ({
          email: p.email,
          agentId: p.agentId,
          problems: auditAgentRoutes(await ctx.agents.get(p.agentId, companyId), companyId),
        })),
      );
      return { ok: agents.every((a) => a.problems.length === 0), agents };
    });

    // One event-log row, scoped to the caller's company.
    ctx.data.register("task-event", async (params) => {
      const companyId = typeof params.companyId === "string" ? params.companyId : "";
      const taskId = typeof params.taskId === "string" ? params.taskId : "";
      if (!companyId || !taskId) return null;
      const row = await getTaskRow(ctx.db, taskId);
      return row && row.company_id === companyId ? row : null;
    });

    ctx.tools.register(
      TOOL_HANDOFF,
      HANDOFF_TOOL,
      async (params, run) => {
        try {
          const settings = await loadSettings(ctx, run.companyId);
          const plan = planHandoff(settings, run.agentId, parseHandoffRequest(params));
          await requireSafeAgent(ctx, plan.from.agentId, run.companyId, "your");
          await requireSafeAgent(ctx, plan.to.agentId, run.companyId, "the teammate's");
          const actor = { actorAgentId: run.agentId, actorRunId: run.runId };

          let issueId: string;
          let identifier: string | null = null;
          if (plan.kind === "create") {
            const issue = await ctx.issues.create({
              companyId: run.companyId,
              ...(run.projectId ? { projectId: run.projectId } : {}),
              title: plan.title,
              description: handoffDescription(plan),
              assigneeAgentId: plan.to.agentId,
              originKind: HANDOFF_ORIGIN,
              executionWorkspaceSettings: taskWorkspaceSettings(),
              actor,
            });
            issueId = issue.id;
            identifier = issue.identifier ?? null;
          } else {
            const issue = await ctx.issues.get(plan.issueId, run.companyId);
            if (!issue) throw new Refused("ticket not found");
            if (issue.assigneeAgentId !== plan.from.agentId) throw new Refused("you can only hand off tickets assigned to you");
            await ctx.issues.update(plan.issueId, { assigneeAgentId: plan.to.agentId }, run.companyId, actor);
            const note = plan.note ? `\n\n${plan.note}` : "";
            await ctx.issues.createComment(
              plan.issueId,
              `Handed off by ${plan.from.email}'s agent to ${plan.to.email}'s agent via Vision and Tom.${note}`,
              run.companyId,
              { authorAgentId: run.agentId },
            );
            issueId = issue.id;
            identifier = issue.identifier ?? null;
          }

          await recordHandoff(
            ctx.db,
            { taskId: issueId, companyId: run.companyId, owner: plan.from.email, agent: plan.from.agentId, taskKind: "handoff" },
            plan.to.email,
          );
          return {
            content: `Handed off ${identifier ?? issueId} to ${plan.to.email}.`,
            data: { issueId, identifier, assignedTo: plan.to.email, action: plan.kind },
          };
        } catch (err) {
          return refusal(err);
        }
      },
    );

    ctx.tools.register(
      TOOL_RUN_CHECKS,
      RUN_CHECKS_TOOL,
      async (params, run) => {
        try {
          const issueId = typeof (params as { issueId?: unknown })?.issueId === "string" ? (params as { issueId: string }).issueId : "";
          if (!issueId) throw new Refused("issueId is required");
          const settings = await loadSettings(ctx, run.companyId);
          const owner = findPersonByAgent(settings, run.agentId);
          if (!owner) throw new Refused("calling agent is not bound to any person");
          await requireSafeAgent(ctx, run.agentId, run.companyId, "your");

          const issue = await ctx.issues.get(issueId, run.companyId);
          if (!issue) throw new Refused("ticket not found");
          if (issue.assigneeAgentId !== run.agentId) throw new Refused("you can only run checks on tickets assigned to you");
          if (!issue.executionWorkspaceId) throw new Refused("ticket has no isolated worktree yet");
          const ws = await ctx.executionWorkspaces.get(issue.executionWorkspaceId, run.companyId);
          const cwd = ws?.cwd ?? ws?.path ?? null;
          if (!ws || ws.providerType !== "git_worktree" || !cwd) throw new Refused("ticket workspace is not a git worktree");
          if (!ws.baseRef) throw new Refused("ticket worktree has no base branch to compare with");

          const report = await runChecksGate(cwd, ws.baseRef, settings.checks);
          const body = formatReport(report);
          const documentKey = checksDocumentKey();
          await ctx.issues.documents.upsert({
            issueId,
            key: documentKey,
            title: "Checks gate report",
            format: "markdown",
            body,
            companyId: run.companyId,
            changeSummary: report.passed ? "Checks passed" : "Checks failed",
          });
          await ctx.issues.createComment(
            issueId,
            `Checks gate ${report.passed ? "passed" : "FAILED"} on commit ${report.headSha ?? "unknown"}. See the document "${documentKey}".`,
            run.companyId,
            { authorAgentId: run.agentId },
          );
          await ensureTaskRow(ctx.db, {
            taskId: issueId,
            companyId: run.companyId,
            owner: owner.email,
            agent: run.agentId,
            taskKind: "task",
          });
          await recordChecks(ctx.db, issueId, report.passed ? "passed" : "failed");
          return {
            content: `Checks ${report.passed ? "passed" : "failed"}: ${report.results.map((r) => `${r.name} ${r.status}`).join(", ")}.`,
            data: { passed: report.passed, headSha: report.headSha, documentKey, results: report.results.map(({ output: _o, ...r }) => r) },
          };
        } catch (err) {
          return refusal(err);
        }
      },
    );
  },

  async onValidateConfig(config) {
    const parsed = parseSettings(config);
    return parsed.ok ? { ok: true } : { ok: false, errors: parsed.errors };
  },

  async onHealth() {
    return { status: "ok" };
  },
});

export default plugin;
runWorker(plugin, import.meta.url);
