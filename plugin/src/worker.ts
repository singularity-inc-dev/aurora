import { definePlugin, runWorker, type PluginContext, type ToolResult } from "@paperclipai/plugin-sdk";
import { runChecksGate, formatReport } from "./checks.js";
import { findPersonByAgent, parseSettings, type PluginSettings } from "./config.js";
import { ensureTaskRow, getTaskRow, recordChecks, recordHandoff } from "./eventlog.js";
import { handoffDescription, HandoffRefused, parseHandoffRequest, planHandoff } from "./handoff.js";
import { auditAgentRoutes } from "./routes.js";
import { HANDOFF_ORIGIN, NIGHT_TICK_JOB } from "./ids.js";
import { listRuns } from "./nightstore.js";
import { proposeTonight, ProposalRefused, tickAll } from "./nightrunner.js";
import { startTicker, type Ticker } from "./ticker.js";
import { renderBriefing } from "./briefing.js";
import { getAction, getBriefingById, listPendingBriefings, markBriefingSent } from "./briefstore.js";
import { executeLink, previewLink, recordPublishResult, recordPullRequestUpdate } from "./links.js";
import { claimInvite, createInvite, finishInvite, previewInvite } from "./invites.js";
import { listWaitingPullRequests } from "./briefstore.js";
import { HANDOFF_TOOL, PROPOSE_TOOL, RUN_CHECKS_TOOL, TOOL_HANDOFF, TOOL_PROPOSE, TOOL_RUN_CHECKS } from "./tools.js";
import { taskWorkspaceSettings } from "./workspace.js";

export { HANDOFF_ORIGIN } from "./ids.js";
export const CHECKS_DOCUMENT_PREFIX = "vt-checks-";

/**
 * Paperclip 2026.1012.0 lets plugins create issue documents but not update them
 * (its plugin upsert sends no baseRevisionId), so every run gets its own document.
 */
export function checksDocumentKey(now: Date = new Date()): string {
  return CHECKS_DOCUMENT_PREFIX + now.toISOString().replace(/\D/g, "").slice(0, 17);
}

class Refused extends Error {}

let ticker: Ticker | null = null;
let pluginContext: PluginContext | null = null;

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
  if (err instanceof Refused || err instanceof HandoffRefused || err instanceof ProposalRefused) return { error: err.message };
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

    // Tonight's routines for a company: what each person's night is doing.
    ctx.data.register("night-status", async (params) => {
      const companyId = typeof params.companyId === "string" ? params.companyId : "";
      if (!companyId) return [];
      return (await listRuns(ctx.db, companyId, 50)).map((r) => ({
        owner: r.owner,
        nightDate: r.nightDate,
        status: r.status,
        planIssueId: r.planIssueId,
        taskIds: r.taskIds,
        currentIndex: r.currentIndex,
        currentAttempt: r.currentAttempt,
        stopReason: r.stopReason,
      }));
    });

    // One tick drives every person's night routine (see night.ts for the rules).
    // The scheduled job only kicks the ticker; see ticker.ts for why.
    pluginContext = ctx;
    ticker?.stop();
    const nightTicker = startTicker(() => tickAll(ctx, new Date()));
    ticker = nightTicker;
    ctx.jobs.register(NIGHT_TICK_JOB, () => nightTicker.kick());

    ctx.tools.register(TOOL_PROPOSE, PROPOSE_TOOL, async (params, run) => {
      try {
        const settings = await loadSettings(ctx, run.companyId);
        const person = findPersonByAgent(settings, run.agentId);
        if (!person) throw new Refused("calling agent is not bound to any person");
        await requireSafeAgent(ctx, run.agentId, run.companyId, "your");
        const result = await proposeTonight(ctx, settings, person, run, params);
        return {
          content: `Proposed ${result.taskIds.length} task(s). Waiting for ${person.email} to approve the plan.`,
          data: result,
        };
      } catch (err) {
        return refusal(err);
      }
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
          await recordChecks(ctx.db, issueId, report.passed ? "passed" : "failed", report.headSha);
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

  /** Board-only routes for the email service (see manifest `apiRoutes`). */
  async onApiRequest(input) {
    const ctx = pluginContext;
    if (!ctx) return { status: 503, body: { error: "plugin is starting" } };
    const parsed = parseSettings(await ctx.config.get(input.companyId));
    if (!parsed.ok) return { status: 409, body: { error: "plugin settings are invalid" } };
    const settings = parsed.settings;
    const body = (typeof input.body === "object" && input.body !== null ? input.body : {}) as Record<string, unknown>;
    const token = typeof body.token === "string" ? body.token : "";
    const now = new Date();

    switch (input.routeKey) {
      case "briefings-pending": {
        if (!settings.links) return { status: 409, body: { error: "morning email links are not configured" } };
        const pending = await listPendingBriefings(ctx.db, input.companyId);
        if (pending.length === 0) return { status: 200, body: { emails: [] } };
        // Paperclip allows 30 secret reads a minute per company, so only read the key when there is mail to sign.
        const secret = await ctx.secrets.resolve(settings.links.signingSecret, { companyId: input.companyId });
        const emails = [];
        for (const b of pending) {
          const first = b.items.find((i) => i.rejectActionId)?.rejectActionId;
          const expiresAt = (first ? (await getAction(ctx.db, first))?.expiresAt : null) ?? now;
          emails.push(renderBriefing(b, settings.links, secret, expiresAt));
        }
        return { status: 200, body: { emails } };
      }
      case "briefing-sent": {
        const id = input.params.briefingId ?? "";
        if (!(await getBriefingById(ctx.db, input.companyId, id))) return { status: 404, body: { error: "briefing not found" } };
        return { status: 200, body: { marked: await markBriefingSent(ctx.db, input.companyId, id) } };
      }
      case "link-preview":
        return { status: 200, body: await previewLink(ctx, settings, input.companyId, token, now) };
      case "link-execute":
        return { status: 200, body: await executeLink(ctx, settings, input.companyId, token, body.reason, now) };
      case "link-publish-result":
        return { status: 200, body: await recordPublishResult(ctx, settings, input.companyId, token, body, now) };
      case "prs-waiting":
        return {
          status: 200,
          body: {
            repo: settings.github?.repo ?? null,
            pullRequests: (await listWaitingPullRequests(ctx.db, input.companyId)).map((p) => ({ taskId: p.taskId, number: p.number, url: p.url, headSha: p.headSha })),
          },
        };
      case "pr-update":
        return { status: 200, body: await recordPullRequestUpdate(ctx, input.companyId, body) };
      case "invite-create": {
        const created = await createInvite(ctx, settings, input.companyId, body, now);
        return { status: created.ok ? 201 : 409, body: created };
      }
      case "invite-preview":
        return { status: 200, body: await previewInvite(ctx, settings, input.companyId, token, now) };
      case "invite-claim":
        return { status: 200, body: await claimInvite(ctx, settings, input.companyId, token, body.timezone, now) };
      case "invite-finish":
        return { status: 200, body: await finishInvite(ctx, settings, input.companyId, typeof body.inviteId === "string" ? body.inviteId : "", body) };
      default:
        return { status: 404, body: { error: "unknown route" } };
    }
  },

  async onShutdown() {
    ticker?.stop();
    ticker = null;
  },
});

export default plugin;
runWorker(plugin, import.meta.url);
