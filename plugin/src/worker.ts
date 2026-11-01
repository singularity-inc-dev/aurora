import { definePlugin, runWorker, type PluginContext, type ToolResult } from "@paperclipai/plugin-sdk";
import { formatReport, gateWord, localRunner, refusingRunner, runChecksGate, type CommandRunner } from "./checks.js";
import { sandboxRunner } from "./checksandbox.js";
import { findPersonByAgent, findPersonByEmail, parseSettings, sandboxLogin, type Person, type PluginSettings } from "./config.js";
import { ensureTaskRow, getTaskRow, recordChecks, recordHandoff } from "./eventlog.js";
import { handoffDescription, HandoffRefused, parseHandoffRequest, planHandoff } from "./handoff.js";
import { agentProblems, auditSettingsIsolation } from "./isolation.js";
import { HANDOFF_ORIGIN, HANDOVER_TICK_JOB } from "./ids.js";
import { numbersCsv } from "./numbers.js";
import { loadNumbers } from "./numberstore.js";
import { getOpenRun, listRuns } from "./handoverstore.js";
import { askForSuggestions, handOver, limitBounds, parseHandoverRequest, projectAreas, ProposalRefused, suggestTasks, taskLimit, tickAll, withdrawQueued } from "./handoverrunner.js";
import { noteForTask, notesOf, queuedTaskIds } from "./notes.js";
import { startTicker, type Ticker } from "./ticker.js";
import { renderBriefing } from "./briefing.js";
import { getAction, getBriefingById, listPendingBriefings, markBriefingSent } from "./briefstore.js";
import { executeLink, listStuckApprovals, previewLink, recordPublishResult, recordPullRequestUpdate, recoverApproval } from "./links.js";
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

async function requireSafeAgent(ctx: PluginContext, settings: PluginSettings, person: Person, companyId: string, who: string): Promise<void> {
  const problems = agentProblems(settings, person, await ctx.agents.get(person.agentId, companyId), companyId);
  if (problems.length > 0) throw new Refused(`${who} agent is not locked down: ${problems.join("; ")}`);
}

/** Where test and lint commands run: as the owner's agent user, or (isolation off, test beds only) here. */
async function checksRunner(ctx: PluginContext, settings: PluginSettings, owner: Person, companyId: string, cwd: string): Promise<CommandRunner> {
  if (!settings.checks.testCommand && !settings.checks.lintCommand) return refusingRunner;
  const login = sandboxLogin(settings, owner);
  if (login) return sandboxRunner(cwd, login, await ctx.secrets.resolve(login.privateKey, { companyId }));
  return settings.isolation.required ? refusingRunner : localRunner(cwd);
}

function refusal(err: unknown): ToolResult {
  if (err instanceof Refused || err instanceof HandoffRefused || err instanceof ProposalRefused) return { error: err.message };
  throw err;
}

/** Why a route call is refused, or null. Only the Aurora service's own Paperclip user may call. */
export function callerRefused(settings: PluginSettings, actor: { actorType: string; userId?: string | null }): string | null {
  if (!settings.serviceUserId) return "the plugin does not know the Aurora service's Paperclip user yet (serviceUserId); run vt-setup";
  if (actor.actorType !== "user" || !actor.userId || actor.userId !== settings.serviceUserId) return "only the Aurora service may call this";
  return null;
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
          handoverStartHour: p.handoverStartHour,
          maxTasksPerHandover: p.maxTasksPerHandover,
          handoverBudgetCapCents: p.handoverBudgetCapCents,
          keyNames: p.secrets.map((s) => ({ name: s.name, access: s.access })),
        })),
      };
    });

    // Which bound agents still have a side door around the board, or are not isolated.
    ctx.data.register("route-audit", async (params) => {
      const companyId = typeof params.companyId === "string" ? params.companyId : "";
      const parsed = parseSettings(await ctx.config.get(companyId));
      if (!parsed.ok) return { ok: false, errors: parsed.errors };
      const agents = await Promise.all(
        parsed.settings.people.map(async (p) => ({
          email: p.email,
          agentId: p.agentId,
          problems: agentProblems(parsed.settings, p, await ctx.agents.get(p.agentId, companyId), companyId),
        })),
      );
      const settingsProblems = auditSettingsIsolation(parsed.settings);
      return {
        ok: settingsProblems.length === 0 && agents.every((a) => a.problems.length === 0),
        isolationRequired: parsed.settings.isolation.required,
        // Old night-only setting names still stored (they work; vt-setup rewrites them).
        legacyNames: parsed.settings.legacyNames,
        settingsProblems,
        agents,
      };
    });

    // For the admin (vt-check): what the committed CODEOWNERS means to Aurora, and GitHub teams it names (they match nobody).
    ctx.data.register("codeowners", async (params) => {
      const companyId = typeof params.companyId === "string" ? params.companyId : "";
      const parsed = parseSettings(await ctx.config.get(companyId));
      if (!parsed.ok) return { ok: false, errors: parsed.errors };
      try {
        const { areas, notes, teams } = await projectAreas(ctx, parsed.settings, companyId, null);
        return { ok: true, source: areas?.source ?? null, teams: teams ?? [], notes };
      } catch (err) {
        return { ok: false, errors: [err instanceof Error ? err.message : "the repository could not be read"] };
      }
    });

    // One event-log row, scoped to the caller's company.
    ctx.data.register("task-event", async (params) => {
      const companyId = typeof params.companyId === "string" ? params.companyId : "";
      const taskId = typeof params.taskId === "string" ? params.taskId : "";
      if (!companyId || !taskId) return null;
      const row = await getTaskRow(ctx.db, taskId);
      return row && row.company_id === companyId ? row : null;
    });

    // Each person's handovers (newest first): scheduled or "now", and where each one is.
    ctx.data.register("handover-status", async (params) => {
      const companyId = typeof params.companyId === "string" ? params.companyId : "";
      if (!companyId) return [];
      return (await listRuns(ctx.db, companyId, 50)).map((r) => ({
        owner: r.owner,
        handoverKey: r.handoverKey,
        kind: r.kind,
        startsAt: r.startsAt,
        endsAt: r.endsAt,
        status: r.status,
        planIssueId: r.planIssueId,
        taskIds: r.taskIds,
        currentIndex: r.currentIndex,
        currentAttempt: r.currentAttempt,
        stopReason: r.stopReason,
      }));
    });

    // One tick drives every person's handovers (see handover.ts for the rules).
    // The scheduled job only kicks the ticker; see ticker.ts for why.
    pluginContext = ctx;
    ticker?.stop();
    const handoverTicker = startTicker(() => tickAll(ctx, new Date()));
    ticker = handoverTicker;
    ctx.jobs.register(HANDOVER_TICK_JOB, () => handoverTicker.kick());

    // "Help me plan" (off by default): the agent's suggestions become drafts for its owner, nothing more.
    ctx.tools.register(TOOL_PROPOSE, PROPOSE_TOOL, async (params, run) => {
      try {
        const settings = await loadSettings(ctx, run.companyId);
        const person = findPersonByAgent(settings, run.agentId);
        if (!person) throw new Refused("calling agent is not bound to any person");
        await requireSafeAgent(ctx, settings, person, run.companyId, "your");
        const result = await suggestTasks(ctx, settings, person, run, params);
        return { content: result.message, data: result };
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
          await requireSafeAgent(ctx, settings, plan.from, run.companyId, "your");
          await requireSafeAgent(ctx, settings, plan.to, run.companyId, "the teammate's");
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
            // The owner chose this task for their handover: the agent may not swap it away.
            const open = await getOpenRun(ctx.db, run.companyId, plan.from.email);
            if (open?.taskIds.includes(issue.id) || (await queuedTaskIds(ctx.db, run.companyId)).has(issue.id)) {
              throw new Refused("your owner handed this ticket over to you; only your owner can change that");
            }
            // Back to backlog, as a new hand-off starts: the teammate's agent waits for its own owner's approval.
            await ctx.issues.update(plan.issueId, { assigneeAgentId: plan.to.agentId, status: "backlog" }, run.companyId, actor);
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
          await requireSafeAgent(ctx, settings, owner, run.companyId, "your");

          const issue = await ctx.issues.get(issueId, run.companyId);
          if (!issue) throw new Refused("ticket not found");
          if (issue.assigneeAgentId !== run.agentId) throw new Refused("you can only run checks on tickets assigned to you");
          if (!issue.executionWorkspaceId) throw new Refused("ticket has no isolated worktree yet");
          const ws = await ctx.executionWorkspaces.get(issue.executionWorkspaceId, run.companyId);
          const cwd = ws?.cwd ?? ws?.path ?? null;
          if (!ws || ws.providerType !== "git_worktree" || !cwd) throw new Refused("ticket workspace is not a git worktree");
          if (!ws.baseRef) throw new Refused("ticket worktree has no base branch to compare with");

          // The owner's handover note limits the task to its files; a change anywhere else fails the gate.
          const note = await noteForTask(ctx.db, issueId);
          const report = await runChecksGate(cwd, ws.baseRef, settings.checks, await checksRunner(ctx, settings, owner, run.companyId, cwd), note?.claims ?? null);
          const body = formatReport(report);
          const documentKey = checksDocumentKey();
          await ctx.issues.documents.upsert({
            issueId,
            key: documentKey,
            title: "Checks gate report",
            format: "markdown",
            body,
            companyId: run.companyId,
            changeSummary: `Checks ${gateWord(report.result)}`,
          });
          await ctx.issues.createComment(
            issueId,
            `Checks gate ${gateWord(report.result)} on commit ${report.headSha ?? "unknown"}. See the document "${documentKey}".`,
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
          await recordChecks(ctx.db, issueId, report.result, report.headSha);
          return {
            content: `Checks ${report.result === "passed" || report.result === "failed" ? report.result : gateWord(report.result)}: ${report.results.map((r) => `${r.name} ${r.status}`).join(", ")}.`,
            data: { passed: report.passed, result: report.result, headSha: report.headSha, documentKey, results: report.results.map(({ output: _o, ...r }) => r) },
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

  /**
   * Board-only routes for the Aurora service (see manifest `apiRoutes`). Paperclip
   * lets any signed-in person call a board route, so each call must come from the
   * service's own Paperclip user (`serviceUserId`); otherwise a teammate could act
   * for someone else. The service proves the owner (their Paperclip sign-in or
   * their signed link) before it calls.
   */
  async onApiRequest(input) {
    const ctx = pluginContext;
    if (!ctx) return { status: 503, body: { error: "plugin is starting" } };
    // Who is calling: vt-setup reads this with the service's key to fill in serviceUserId.
    if (input.routeKey === "caller") return { status: 200, body: { actorType: input.actor.actorType, userId: input.actor.userId ?? null } };
    const parsed = parseSettings(await ctx.config.get(input.companyId));
    if (!parsed.ok) return { status: 409, body: { error: "plugin settings are invalid" } };
    const settings = parsed.settings;
    const refused = callerRefused(settings, input.actor);
    if (refused) return { status: 403, body: { ok: false, error: refused, message: refused } };
    const body = (typeof input.body === "object" && input.body !== null ? input.body : {}) as Record<string, unknown>;
    const token = typeof body.token === "string" ? body.token : "";
    const now = new Date();
    const owner = () => {
      const email = typeof body.email === "string" ? body.email : typeof input.query?.email === "string" ? input.query.email : "";
      return findPersonByEmail(settings, email);
    };

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
        return { status: 200, body: await executeLink(ctx, settings, input.companyId, token, body.reason, now, body.signedInAs) };
      case "link-publish-result":
        return { status: 200, body: await recordPublishResult(ctx, settings, input.companyId, token, body, now) };
      case "links-stuck":
        // Approvals interrupted between the tap and GitHub (gap 27); the email service finishes them.
        return { status: 200, body: { approvals: await listStuckApprovals(ctx, settings, input.companyId, input.query?.olderThanMinutes, now) } };
      case "link-recover":
        return { status: 200, body: await recoverApproval(ctx, settings, input.companyId, body, now) };
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
      case "handover-start": {
        // The owner's tap on Hand over. The service calls this only for the owner signed in to Paperclip.
        const person = owner();
        if (!person) return { status: 404, body: { ok: false, message: "you are not on the team" } };
        const request = parseHandoverRequest(body, settings, person);
        if (typeof request === "string") return { status: 400, body: { ok: false, message: request } };
        const result = await handOver(ctx, input.companyId, settings, person, request, now);
        return { status: result.ok ? 201 : 409, body: result };
      }
      case "handover-withdraw": {
        const person = owner();
        if (!person) return { status: 404, body: { ok: false, message: "you are not on the team" } };
        return { status: 200, body: await withdrawQueued(ctx, input.companyId, person) };
      }
      case "handover-suggest": {
        const person = owner();
        if (!person) return { status: 404, body: { ok: false, message: "you are not on the team" } };
        const asked = await askForSuggestions(ctx, input.companyId, settings, person);
        return { status: asked.ok ? 201 : 409, body: asked };
      }
      case "handover-status": {
        const person = owner();
        if (!person) return { status: 404, body: { ok: false, message: "you are not on the team" } };
        const runs = (await listRuns(ctx.db, input.companyId, 50)).filter((r) => r.owner === person.email).slice(0, 5);
        // The tickets the owner can hand over: their agent's backlog, minus the ones already waiting.
        const queued = await notesOf(ctx.db, input.companyId, person.email, "queued");
        const backlog = (await ctx.issues.list({ companyId: input.companyId, assigneeAgentId: person.agentId, status: "backlog", limit: 20 })).filter(
          (i) => !queued.some((q) => q.taskId === i.id),
        );
        const drafts = await notesOf(ctx.db, input.companyId, person.email, "draft");
        const bounds = limitBounds(settings, person);
        return {
          status: 200,
          body: {
            ok: true,
            email: person.email,
            timezone: person.timezone,
            handoverStartHour: person.handoverStartHour,
            maxTasks: taskLimit(person),
            helpMePlan: person.helpMePlan,
            limits: bounds,
            tickets: backlog.map((i) => {
              const draft = drafts.filter((d) => d.taskId === i.id).pop();
              return {
                id: i.id,
                identifier: i.identifier ?? null,
                title: i.title,
                description: (i.description ?? "").slice(0, 2000),
                draft: draft ? { source: draft.source, what: draft.what, doneWhen: draft.doneWhen, files: draft.claims.join(", ") } : null,
              };
            }),
            queued: queued.map((q) => ({ taskId: q.taskId, title: q.title, doneWhen: q.doneWhen })),
            handovers: runs.map((r) => ({ handoverKey: r.handoverKey, kind: r.kind, status: r.status, stopReason: r.stopReason })),
          },
        };
      }
      case "numbers":
        return { status: 200, body: await loadNumbers(ctx, input.companyId) };
      case "numbers-csv":
        // Paperclip 2026.1012.0 sends plugin route bodies as JSON (headers are not passed on),
        // so the CSV text travels inside JSON; vt-numbers writes it to a file.
        return { status: 200, body: { csv: numbersCsv(await loadNumbers(ctx, input.companyId)) } };
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
