import type { PluginContext } from "@paperclipai/plugin-sdk";
import { MAX_TASKS_PER_NIGHT, parseSettings, type Person, type PluginSettings } from "./config.js";
import { decideNight, type NightDecision, type NightRun, type StepClose } from "./night.js";
import { nightClock } from "./nightclock.js";
import { claimRun, getLatestDoneRun, getOpenRun, getRun, setTaskOutcome, spentSince, stampTasks, updateRun } from "./nightstore.js";
import { createBriefing } from "./briefing.js";
import { getBriefing } from "./briefstore.js";
import type { NightClock } from "./nightclock.js";
import { ensureTaskRow } from "./eventlog.js";
import { NIGHT_TASK_ORIGIN, PLAN_ORIGIN } from "./ids.js";
import { parseProposal, ProposalRefused } from "./proposal.js";
import { taskWorkspaceSettings } from "./workspace.js";
import { auditAgentRoutes } from "./routes.js";
import { TOOL_PROPOSE } from "./tools.js";

export { ProposalRefused };


/** Run one tick for every company that has valid plugin settings. */
export async function tickAll(ctx: PluginContext, now: Date): Promise<void> {
  const companies = await ctx.companies.list();
  for (const company of companies) {
    // Paperclip only lets the plugin read companies it is configured in; skip the rest.
    const raw = await ctx.config.get(company.id).catch(() => null);
    if (raw === null) continue;
    const parsed = parseSettings(raw);
    if (!parsed.ok) continue; // fail closed: invalid settings, no night work
    await tickCompany(ctx, company.id, parsed.settings, now);
  }
}

export async function tickCompany(ctx: PluginContext, companyId: string, settings: PluginSettings, now: Date): Promise<void> {
  for (const person of settings.people) {
    try {
      await tickPerson(ctx, companyId, settings, person, now);
    } catch (err) {
      ctx.logger.error("night tick failed for one person", { companyId, owner: person.email, error: err instanceof Error ? err.message : "unknown" });
    }
  }
}

export async function tickPerson(ctx: PluginContext, companyId: string, settings: PluginSettings, person: Person, now: Date): Promise<NightDecision> {
  const clock = nightClock(now, person.timezone, person.nightStartHour, settings.night.proposalLeadHours, settings.night.nightLengthHours);
  const decision = await decideAndApply(ctx, companyId, settings, person, clock, now);
  // After the night is over (possibly closed just now), build the morning briefing once.
  await maybeBrief(ctx, companyId, settings, person, clock, now);
  return decision;
}

async function decideAndApply(
  ctx: PluginContext,
  companyId: string,
  settings: PluginSettings,
  person: Person,
  clock: NightClock,
  now: Date,
): Promise<NightDecision> {
  const run = (await getOpenRun(ctx.db, companyId, person.email)) ?? (await getRun(ctx.db, companyId, person.email, clock.nightDate));
  // A finished night for this date stays finished: one routine per person per night.
  if (run && !["proposing", "awaiting_approval", "approved", "running"].includes(run.status)) return { kind: "none" };

  // Budget window: from the start of the run's own night (yesterday's if it is still open).
  const nightStart = run && run.nightDate !== clock.nightDate ? new Date(clock.startsAt.getTime() - 24 * 3600_000) : clock.startsAt;
  const decision = decideNight(
    run,
    clock,
    {
      approval: run ? await readApproval(ctx, run) : null,
      currentTaskStatus: run && run.currentIndex >= 0 ? await taskStatus(ctx, companyId, run.taskIds[run.currentIndex]) : null,
      spentCents: await spentSince(ctx.db, companyId, person.agentId, nightStart < now ? nightStart : now),
    },
    person,
    settings.night,
    now,
  );
  await apply(ctx, companyId, settings, person, run, clock.nightDate, decision, now);
  return decision;
}

/** Once a person's night is over, build its morning briefing (once). */
async function maybeBrief(ctx: PluginContext, companyId: string, settings: PluginSettings, person: Person, clock: NightClock, now: Date): Promise<void> {
  if (!settings.links) return; // fail closed: no signed links, no briefing
  const run = await getLatestDoneRun(ctx.db, companyId, person.email);
  if (!run || run.taskIds.length === 0) return;
  if (clock.phase === "night" && clock.nightDate === run.nightDate) return; // wait for the morning
  if (await getBriefing(ctx.db, companyId, person.email, run.nightDate)) return;
  await createBriefing(ctx, person, settings.links, run, now);
}

async function taskStatus(ctx: PluginContext, companyId: string, taskId: string | undefined): Promise<string | null> {
  if (!taskId) return null;
  return (await ctx.issues.get(taskId, companyId))?.status ?? null;
}

async function readApproval(ctx: PluginContext, run: NightRun): Promise<{ status: string; outcome: string | null; reason: string | null } | null> {
  if (run.status !== "awaiting_approval" || !run.planIssueId || !run.interactionId) return null;
  const interactions = await ctx.issues.listInteractions(run.planIssueId, run.companyId);
  const found = interactions.find((i) => i.id === run.interactionId);
  if (!found) return null;
  const result = (found as { result?: { outcome?: string; reason?: string | null } | null }).result ?? null;
  return { status: found.status, outcome: result?.outcome ?? null, reason: result?.reason ?? null };
}

async function agentIsSafe(ctx: PluginContext, companyId: string, agentId: string): Promise<boolean> {
  return auditAgentRoutes(await ctx.agents.get(agentId, companyId), companyId).length === 0;
}

async function comment(ctx: PluginContext, companyId: string, issueId: string | null, body: string): Promise<void> {
  if (issueId) await ctx.issues.createComment(issueId, body, companyId);
}

async function apply(
  ctx: PluginContext,
  companyId: string,
  settings: PluginSettings,
  person: Person,
  run: NightRun | null,
  nightDate: string,
  d: NightDecision,
  now: Date,
): Promise<void> {
  switch (d.kind) {
    case "none":
      return;

    case "open-plan": {
      if (!(await agentIsSafe(ctx, companyId, person.agentId))) {
        ctx.logger.warn("evening plan skipped: agent is not locked down", { companyId, owner: person.email });
        return;
      }
      let current = run;
      if (!current) {
        if (!(await claimRun(ctx.db, { companyId, owner: person.email, agentId: person.agentId, nightDate }))) return;
        current = await getRun(ctx.db, companyId, person.email, nightDate);
        if (!current) return;
      }
      const limit = Math.min(person.maxTasksPerNight, MAX_TASKS_PER_NIGHT);
      const backlog = await ctx.issues.list({ companyId, assigneeAgentId: person.agentId, status: "backlog", limit: 20 });
      const waiting = backlog.length
        ? `\n\nTickets already waiting for you (propose them by issueId):\n${backlog.map((i) => `- ${i.identifier ?? i.id} ${i.title} (issueId ${i.id})`).join("\n")}`
        : "";
      const plan = await ctx.issues.create({
        companyId,
        ...(settings.night.projectId ? { projectId: settings.night.projectId } : {}),
        title: `Evening plan for ${person.email}, night of ${nightDate}`,
        description:
          `Propose up to ${limit} task(s) for tonight with the \`${TOOL_PROPOSE}\` tool. ` +
          `Nothing runs until ${person.email} approves the plan. Work starts at ${String(person.nightStartHour).padStart(2, "0")}:00 ${person.timezone}.${waiting}`,
        status: "todo",
        assigneeAgentId: person.agentId,
        originKind: PLAN_ORIGIN,
      });
      await updateRun(ctx.db, current, { planIssueId: plan.id });
      return;
    }

    case "approve": {
      if (!run || !(await updateRun(ctx.db, run, { status: "approved" }))) return;
      await stampTasks(ctx.db, run.taskIds, "approved_at", now);
      await comment(ctx, companyId, run.planIssueId, `Plan approved. Work starts at the night start (${person.timezone}).`);
      if (run.planIssueId) await ctx.issues.update(run.planIssueId, { status: "done" }, companyId);
      return;
    }

    case "reject": {
      if (!run || !(await updateRun(ctx.db, run, { status: "rejected", stopReason: d.reason ?? "rejected" }))) return;
      for (const taskId of run.taskIds) await setTaskOutcome(ctx.db, taskId, "rejected", d.reason);
      if (run.planIssueId) await ctx.issues.update(run.planIssueId, { status: "done" }, companyId);
      return;
    }

    case "expire": {
      if (!run || !(await updateRun(ctx.db, run, { status: "expired", stopReason: d.reason }))) return;
      await comment(ctx, companyId, run.planIssueId, `No night work: ${d.reason}.`);
      if (run.planIssueId) await ctx.issues.update(run.planIssueId, { status: "done" }, companyId);
      return;
    }

    case "retry-step": {
      if (!run) return;
      const taskId = run.taskIds[run.currentIndex];
      if (!taskId || !(await updateRun(ctx.db, run, { currentAttempt: d.attempt, stepStartedAt: now }))) return;
      await comment(ctx, companyId, taskId, `Time limit of ${settings.night.stepTimeoutMinutes} minutes passed. Retrying (attempt ${d.attempt}).`);
      // Paperclip wakes the assignee when a ticket moves from backlog to todo.
      await ctx.issues.update(taskId, { status: "backlog" }, companyId);
      await ctx.issues.update(taskId, { status: "todo" }, companyId);
      return;
    }

    case "advance": {
      if (!run) return;
      await advance(ctx, companyId, person, run, d.close, d.then, now);
      return;
    }
  }
}

async function advance(
  ctx: PluginContext,
  companyId: string,
  person: Person,
  run: NightRun,
  close: StepClose | null,
  then: { start: number } | { finish: string } | { budgetStop: true },
  now: Date,
): Promise<void> {
  const currentId = run.currentIndex >= 0 ? run.taskIds[run.currentIndex] : undefined;
  let patch: Parameters<typeof updateRun>[2];
  if ("start" in then) patch = { status: "running", currentIndex: then.start, currentAttempt: 1, stepStartedAt: now };
  else if ("finish" in then) patch = { status: "finished", stopReason: then.finish };
  else patch = { status: "budget_stopped", stopReason: "night budget cap reached" };
  if (!(await updateRun(ctx.db, run, patch))) return;

  if (close && currentId) {
    await stampTasks(ctx.db, [currentId], "finished_at", now);
    if (close.outcome !== "finished") {
      await setTaskOutcome(ctx.db, currentId, close.outcome, null);
      const status = (await ctx.issues.get(currentId, companyId))?.status;
      if (status && !["done", "in_review", "cancelled"].includes(status)) await ctx.issues.update(currentId, { status: "blocked" }, companyId);
      await comment(ctx, companyId, currentId, `Night routine stopped this task: ${close.reason ?? close.outcome}.`);
    }
  }

  if ("start" in then) {
    const nextId = run.taskIds[then.start];
    if (!nextId) return;
    if (!(await agentIsSafe(ctx, companyId, person.agentId))) {
      await comment(ctx, companyId, run.planIssueId, "Night routine paused: the agent is no longer locked down (see route-audit).");
      return;
    }
    await stampTasks(ctx.db, [nextId], "started_at", now);
    await ctx.issues.update(nextId, { status: "todo" }, companyId);
  } else if ("budgetStop" in then) {
    // Automatic tier: pause the agent so it cannot keep spending; resuming stays manual.
    try {
      await ctx.agents.pause(person.agentId, companyId);
    } catch (err) {
      ctx.logger.warn("could not pause agent at budget cap", { companyId, owner: person.email, error: err instanceof Error ? err.message : "unknown" });
    }
    await comment(
      ctx,
      companyId,
      run.planIssueId,
      `Stopped for tonight: the night budget cap of ${person.nightBudgetCapCents} cents was reached. The agent is paused; resume it in Paperclip.`,
    );
  } else {
    await comment(ctx, companyId, run.planIssueId, `Night finished: ${then.finish}.`);
  }
}

export interface ProposeResult {
  planIssueId: string;
  taskIds: string[];
}

/**
 * Handle an agent's evening proposal: create or pick up to 3 backlog tickets,
 * record them, and ask the owner for one-tap approval on the plan ticket.
 * Agents cannot approve: the request is `human_only`.
 */
export async function proposeTonight(
  ctx: PluginContext,
  settings: PluginSettings,
  person: Person,
  run: { companyId: string; agentId: string; runId: string },
  params: unknown,
): Promise<ProposeResult> {
  const companyId = run.companyId;
  const tasks = parseProposal(params, person);
  const night = await getOpenRun(ctx.db, companyId, person.email);
  if (!night || night.status !== "proposing" || !night.planIssueId) throw new ProposalRefused("no evening plan is open for you right now");
  const plan = await ctx.issues.get(night.planIssueId, companyId);
  if (!plan) throw new ProposalRefused("evening plan ticket not found");

  // Check every referenced ticket before creating anything.
  for (const t of tasks) {
    if (!("issueId" in t)) continue;
    const issue = await ctx.issues.get(t.issueId, companyId);
    if (!issue || issue.assigneeAgentId !== person.agentId) throw new ProposalRefused("you can only propose tickets assigned to you");
    if (issue.status !== "backlog") throw new ProposalRefused(`ticket ${issue.identifier ?? issue.id} is not in backlog`);
  }

  const actor = { actorAgentId: run.agentId, actorRunId: run.runId };
  const projectId = settings.night.projectId ?? plan.projectId ?? undefined;
  const taskIds: string[] = [];
  const lines: string[] = [];
  for (const t of tasks) {
    if ("issueId" in t) {
      const issue = (await ctx.issues.get(t.issueId, companyId))!;
      await ensureTaskRow(ctx.db, { taskId: issue.id, companyId, owner: person.email, agent: person.agentId, taskKind: "task" });
      taskIds.push(issue.id);
      lines.push(`- ${issue.identifier ?? issue.id}: ${issue.title}`);
    } else {
      const issue = await ctx.issues.create({
        companyId,
        ...(projectId ? { projectId } : {}),
        title: t.title,
        description: t.description ? `${t.description}\n\nProposed for the night of ${night.nightDate}.` : `Proposed for the night of ${night.nightDate}.`,
        status: "backlog",
        assigneeAgentId: person.agentId,
        originKind: NIGHT_TASK_ORIGIN,
        executionWorkspaceSettings: taskWorkspaceSettings(),
        actor,
      });
      await ensureTaskRow(ctx.db, { taskId: issue.id, companyId, owner: person.email, agent: person.agentId, taskKind: "task" });
      taskIds.push(issue.id);
      lines.push(`- ${issue.identifier ?? issue.id}: ${issue.title}`);
    }
  }
  const now = new Date();
  await stampTasks(ctx.db, taskIds, "proposed_at", now);

  const interaction = await ctx.issues.requestConfirmation(
    night.planIssueId,
    {
      idempotencyKey: `vt-plan:${companyId}:${person.email}:${night.nightDate}`,
      title: "Tonight's plan",
      resolverPolicy: "human_only",
      continuationPolicy: "none",
      payload: {
        version: 1,
        prompt: `Approve tonight's plan for ${person.email}? Nothing shared changes until you approve each result in the morning.`,
        acceptLabel: "Approve tonight's plan",
        rejectLabel: "Not tonight",
        allowDeclineReason: true,
        supersedeOnUserComment: false,
        detailsMarkdown: lines.join("\n"),
      },
    },
    companyId,
    { authorAgentId: run.agentId },
  );

  if (!(await updateRun(ctx.db, night, { status: "awaiting_approval", taskIds, interactionId: interaction.id }))) {
    throw new ProposalRefused("the evening plan changed while proposing; try again");
  }
  await ctx.issues.update(night.planIssueId, { status: "in_review" }, companyId, actor);
  return { planIssueId: night.planIssueId, taskIds };
}
