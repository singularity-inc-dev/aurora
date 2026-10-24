import type { PluginContext } from "@paperclipai/plugin-sdk";
import { MAX_TASKS_PER_HANDOVER, parseSettings, type Person, type PluginSettings } from "./config.js";
import { decideHandover, OPEN_STATUSES, windowOf, type HandoverDecision, type HandoverRun, type StepClose } from "./handover.js";
import { handoverClock } from "./schedule.js";
import { claimRun, getLatestDoneRun, getOpenRun, getRun, setTaskOutcome, spentSince, stampTasks, updateRun } from "./handoverstore.js";
import { createBriefing } from "./briefing.js";
import { earlierBriefingTaskIds, getBriefing } from "./briefstore.js";
import type { HandoverClock } from "./schedule.js";
import { ensureTaskRow } from "./eventlog.js";
import { HANDOVER_TASK_ORIGIN, PLAN_ORIGIN } from "./ids.js";
import { parseProposal, ProposalRefused } from "./proposal.js";
import { taskWorkspaceSettings } from "./workspace.js";
import { agentProblems } from "./isolation.js";
import { TOOL_PROPOSE } from "./tools.js";
import { assertTier } from "./tiers.js";

export { ProposalRefused };


/** Run one tick for every company that has valid plugin settings. */
export async function tickAll(ctx: PluginContext, now: Date): Promise<void> {
  const companies = await ctx.companies.list();
  for (const company of companies) {
    // Paperclip only lets the plugin read companies it is configured in; skip the rest.
    const raw = await ctx.config.get(company.id).catch(() => null);
    if (raw === null) continue;
    const parsed = parseSettings(raw);
    if (!parsed.ok) continue; // fail closed: invalid settings, no handover work
    await tickCompany(ctx, company.id, parsed.settings, now);
  }
}

export async function tickCompany(ctx: PluginContext, companyId: string, settings: PluginSettings, now: Date): Promise<void> {
  for (const person of settings.people) {
    try {
      await tickPerson(ctx, companyId, settings, person, now);
    } catch (err) {
      ctx.logger.error("handover tick failed for one person", { companyId, owner: person.email, error: err instanceof Error ? err.message : "unknown" });
    }
  }
}

function scheduleOf(settings: PluginSettings, person: Person, now: Date): HandoverClock {
  return handoverClock(now, person.timezone, person.handoverStartHour, settings.handover.proposalLeadHours, settings.handover.handoverLengthHours);
}

export type StartNow = { ok: true; handoverKey: string; planIssueId: string | null } | { ok: false; message: string };

/**
 * "Hand over now" (thin version 1, piece C): start a handover right away, next to
 * the schedule. The owner tapped it; the agent plans at once, the owner approves
 * the plan as always, and work starts as soon as it is approved. At most one
 * handover per person is open at a time.
 */
export async function startHandoverNow(ctx: PluginContext, companyId: string, settings: PluginSettings, person: Person, now: Date): Promise<StartNow> {
  assertTier("start-handover-now", "needs-tap");
  const open = await getOpenRun(ctx.db, companyId, person.email);
  if (open) return { ok: false, message: `a handover is already in progress (${open.status.replace("_", " ")})` };
  if (!(await agentIsSafe(ctx, settings, companyId, person))) return { ok: false, message: "your agent is not locked down yet (see the plugin's route audit)" };
  const handoverKey = now.toISOString().slice(0, 16);
  const endsAt = new Date(now.getTime() + settings.handover.handoverLengthHours * 3600_000);
  if (!(await claimRun(ctx.db, { companyId, owner: person.email, agentId: person.agentId, handoverKey, kind: "now", startsAt: now, endsAt }))) {
    return { ok: false, message: "a handover was just started; wait a minute" };
  }
  await tickPerson(ctx, companyId, settings, person, now);
  return { ok: true, handoverKey, planIssueId: (await getRun(ctx.db, companyId, person.email, handoverKey))?.planIssueId ?? null };
}

export async function tickPerson(ctx: PluginContext, companyId: string, settings: PluginSettings, person: Person, now: Date): Promise<HandoverDecision> {
  const clock = scheduleOf(settings, person, now);
  const decision = await decideAndApply(ctx, companyId, settings, person, clock, now);
  // Once a handover is done (possibly just now), build its handback email once.
  await maybeBrief(ctx, companyId, settings, person, clock, now);
  return decision;
}

async function decideAndApply(
  ctx: PluginContext,
  companyId: string,
  settings: PluginSettings,
  person: Person,
  clock: HandoverClock,
  now: Date,
): Promise<HandoverDecision> {
  const run = (await getOpenRun(ctx.db, companyId, person.email)) ?? (await getRun(ctx.db, companyId, person.email, clock.handoverKey));
  // A finished scheduled handover for this date stays finished: one per person per day.
  if (run && !OPEN_STATUSES.includes(run.status)) return { kind: "none" };

  // The budget counts from the start of this handover's own window.
  const windowStart = run ? windowOf(run, clock).start : clock.startsAt;
  const decision = decideHandover(
    run,
    clock,
    {
      approval: run ? await readApproval(ctx, run) : null,
      currentTaskStatus: run && run.currentIndex >= 0 ? await taskStatus(ctx, companyId, run.taskIds[run.currentIndex]) : null,
      spentCents: await spentSince(ctx.db, companyId, person.agentId, windowStart < now ? windowStart : now),
    },
    person,
    settings.handover,
    now,
  );
  await apply(ctx, companyId, settings, person, run, clock.handoverKey, decision, now);
  return decision;
}

/** The calendar date before `date` (YYYY-MM-DD). */
export function previousDate(date: string): string {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

/**
 * Once a person's handover is done, build its handback email (once): right away
 * for a "now" handover, after its window for a scheduled one. Tasks from earlier
 * emails that are still undecided come back in it with fresh links, also on a
 * morning after a scheduled handover without work.
 */
async function maybeBrief(ctx: PluginContext, companyId: string, settings: PluginSettings, person: Person, clock: HandoverClock, now: Date): Promise<void> {
  if (!settings.links) return; // fail closed: no signed links, no briefing
  const run = await getLatestDoneRun(ctx.db, companyId, person.email);
  const stillInItsWindow = run?.kind === "scheduled" && now >= windowOf(run, clock).start && now < windowOf(run, clock).end;
  if (run && run.taskIds.length > 0 && !stillInItsWindow) {
    if (!(await getBriefing(ctx.db, companyId, person.email, run.handoverKey))) {
      const carried = await earlierBriefingTaskIds(ctx.db, companyId, person.email, run.handoverKey);
      await createBriefing(ctx, person, settings.links, companyId, run.handoverKey, run, carried, now);
      return;
    }
  }
  // The day before today's schedule: a morning without a finished handover still gets the undecided tasks.
  const lastDay = previousDate(clock.handoverKey);
  if (run && run.taskIds.length > 0 && run.handoverKey >= lastDay) return;
  if (await getBriefing(ctx.db, companyId, person.email, lastDay)) return;
  const open = await getRun(ctx.db, companyId, person.email, lastDay);
  if (open && OPEN_STATUSES.includes(open.status)) return;
  const carried = await earlierBriefingTaskIds(ctx.db, companyId, person.email, lastDay);
  if (carried.length === 0) return;
  await createBriefing(ctx, person, settings.links, companyId, lastDay, null, carried, now);
}

async function taskStatus(ctx: PluginContext, companyId: string, taskId: string | undefined): Promise<string | null> {
  if (!taskId) return null;
  return (await ctx.issues.get(taskId, companyId))?.status ?? null;
}

async function readApproval(ctx: PluginContext, run: HandoverRun): Promise<{ status: string; outcome: string | null; reason: string | null } | null> {
  if (run.status !== "awaiting_approval" || !run.planIssueId || !run.interactionId) return null;
  const interactions = await ctx.issues.listInteractions(run.planIssueId, run.companyId);
  const found = interactions.find((i) => i.id === run.interactionId);
  if (!found) return null;
  const result = (found as { result?: { outcome?: string; reason?: string | null } | null }).result ?? null;
  return { status: found.status, outcome: result?.outcome ?? null, reason: result?.reason ?? null };
}

async function agentIsSafe(ctx: PluginContext, settings: PluginSettings, companyId: string, person: Person): Promise<boolean> {
  return agentProblems(settings, person, await ctx.agents.get(person.agentId, companyId), companyId).length === 0;
}

async function comment(ctx: PluginContext, companyId: string, issueId: string | null, body: string): Promise<void> {
  if (issueId) await ctx.issues.createComment(issueId, body, companyId);
}

async function apply(
  ctx: PluginContext,
  companyId: string,
  settings: PluginSettings,
  person: Person,
  run: HandoverRun | null,
  handoverKey: string,
  d: HandoverDecision,
  now: Date,
): Promise<void> {
  switch (d.kind) {
    case "none":
      return;

    case "open-plan": {
      if (!(await agentIsSafe(ctx, settings, companyId, person))) {
        ctx.logger.warn("handover plan skipped: agent is not locked down", { companyId, owner: person.email });
        return;
      }
      let current = run;
      if (!current) {
        const clock = scheduleOf(settings, person, now);
        const window = { startsAt: clock.startsAt, endsAt: clock.endsAt };
        if (!(await claimRun(ctx.db, { companyId, owner: person.email, agentId: person.agentId, handoverKey, kind: "scheduled", ...window }))) return;
        current = await getRun(ctx.db, companyId, person.email, handoverKey);
        if (!current) return;
      }
      const limit = Math.min(person.maxTasksPerHandover, MAX_TASKS_PER_HANDOVER);
      const backlog = await ctx.issues.list({ companyId, assigneeAgentId: person.agentId, status: "backlog", limit: 20 });
      const waiting = backlog.length
        ? `\n\nTickets already waiting for you (propose them by issueId):\n${backlog.map((i) => `- ${i.identifier ?? i.id} ${i.title} (issueId ${i.id})`).join("\n")}`
        : "";
      const plan = await ctx.issues.create({
        companyId,
        ...(settings.handover.projectId ? { projectId: settings.handover.projectId } : {}),
        title: current.kind === "now" ? `Plan for ${person.email}'s handover now (${handoverKey} UTC)` : `Plan for ${person.email}'s handover of ${handoverKey}`,
        description:
          `Propose up to ${limit} task(s) for this handover with the \`${TOOL_PROPOSE}\` tool. ` +
          `Nothing runs until ${person.email} approves the plan. Work starts at ${String(person.handoverStartHour).padStart(2, "0")}:00 ${person.timezone}.${waiting}`,
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
      await comment(ctx, companyId, run.planIssueId, run.kind === "now" ? "Plan approved. Work starts now." : `Plan approved. Work starts at the handover time (${person.timezone}).`);
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
      await comment(ctx, companyId, run.planIssueId, `No handover work: ${d.reason}.`);
      if (run.planIssueId) await ctx.issues.update(run.planIssueId, { status: "done" }, companyId);
      return;
    }

    case "retry-step": {
      if (!run) return;
      const taskId = run.taskIds[run.currentIndex];
      if (!taskId || !(await updateRun(ctx.db, run, { currentAttempt: d.attempt, stepStartedAt: now }))) return;
      await comment(ctx, companyId, taskId, `Time limit of ${settings.handover.stepTimeoutMinutes} minutes passed. Retrying (attempt ${d.attempt}).`);
      // Paperclip wakes the assignee when a ticket moves from backlog to todo.
      await ctx.issues.update(taskId, { status: "backlog" }, companyId);
      await ctx.issues.update(taskId, { status: "todo" }, companyId);
      return;
    }

    case "advance": {
      if (!run) return;
      await advance(ctx, companyId, settings, person, run, d.close, d.then, now);
      return;
    }
  }
}

async function advance(
  ctx: PluginContext,
  companyId: string,
  settings: PluginSettings,
  person: Person,
  run: HandoverRun,
  close: StepClose | null,
  then: { start: number } | { finish: string } | { budgetStop: true },
  now: Date,
): Promise<void> {
  const currentId = run.currentIndex >= 0 ? run.taskIds[run.currentIndex] : undefined;
  let patch: Parameters<typeof updateRun>[2];
  if ("start" in then) patch = { status: "running", currentIndex: then.start, currentAttempt: 1, stepStartedAt: now };
  else if ("finish" in then) patch = { status: "finished", stopReason: then.finish };
  else patch = { status: "budget_stopped", stopReason: "handover budget cap reached" };
  if (!(await updateRun(ctx.db, run, patch))) return;

  if (close && currentId) {
    await stampTasks(ctx.db, [currentId], "finished_at", now);
    if (close.outcome !== "finished") {
      await setTaskOutcome(ctx.db, currentId, close.outcome, null);
      const status = (await ctx.issues.get(currentId, companyId))?.status;
      if (status && !["done", "in_review", "cancelled"].includes(status)) await ctx.issues.update(currentId, { status: "blocked" }, companyId);
      await comment(ctx, companyId, currentId, `The handover stopped this task: ${close.reason ?? close.outcome}.`);
    }
  }

  if ("start" in then) {
    const nextId = run.taskIds[then.start];
    if (!nextId) return;
    if (!(await agentIsSafe(ctx, settings, companyId, person))) {
      await comment(ctx, companyId, run.planIssueId, "Handover paused: the agent is no longer locked down (see route-audit).");
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
      `Handover stopped: its budget cap of ${person.handoverBudgetCapCents} cents was reached. The agent is paused; resume it in Paperclip.`,
    );
  } else {
    await comment(ctx, companyId, run.planIssueId, `Handover finished: ${then.finish}.`);
  }
}

export interface ProposeResult {
  planIssueId: string;
  taskIds: string[];
}

/**
 * Handle an agent's handover proposal: create or pick up to 3 backlog tickets,
 * record them, and ask the owner for one-tap approval on the plan ticket.
 * Agents cannot approve: the request is `human_only`.
 */
export async function proposeHandover(
  ctx: PluginContext,
  settings: PluginSettings,
  person: Person,
  run: { companyId: string; agentId: string; runId: string },
  params: unknown,
): Promise<ProposeResult> {
  const companyId = run.companyId;
  const tasks = parseProposal(params, person);
  const handover = await getOpenRun(ctx.db, companyId, person.email);
  if (!handover || handover.status !== "proposing" || !handover.planIssueId) throw new ProposalRefused("no handover plan is open for you right now");
  const plan = await ctx.issues.get(handover.planIssueId, companyId);
  if (!plan) throw new ProposalRefused("handover plan ticket not found");

  // Check every referenced ticket before creating anything.
  for (const t of tasks) {
    if (!("issueId" in t)) continue;
    const issue = await ctx.issues.get(t.issueId, companyId);
    if (!issue || issue.assigneeAgentId !== person.agentId) throw new ProposalRefused("you can only propose tickets assigned to you");
    if (issue.status !== "backlog") throw new ProposalRefused(`ticket ${issue.identifier ?? issue.id} is not in backlog`);
  }

  const actor = { actorAgentId: run.agentId, actorRunId: run.runId };
  const projectId = settings.handover.projectId ?? plan.projectId ?? undefined;
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
        description: t.description ? `${t.description}\n\nProposed for the handover ${handover.handoverKey}.` : `Proposed for the handover ${handover.handoverKey}.`,
        status: "backlog",
        assigneeAgentId: person.agentId,
        originKind: HANDOVER_TASK_ORIGIN,
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
    handover.planIssueId,
    {
      idempotencyKey: `vt-plan:${companyId}:${person.email}:${handover.handoverKey}`,
      title: "Handover plan",
      resolverPolicy: "human_only",
      continuationPolicy: "none",
      payload: {
        version: 1,
        prompt: `Approve this handover's plan for ${person.email}? Nothing shared changes until you approve each result in the handback email.`,
        acceptLabel: "Approve the plan",
        rejectLabel: "Not this time",
        allowDeclineReason: true,
        supersedeOnUserComment: false,
        detailsMarkdown: lines.join("\n"),
      },
    },
    companyId,
    { authorAgentId: run.agentId },
  );

  if (!(await updateRun(ctx.db, handover, { status: "awaiting_approval", taskIds, interactionId: interaction.id }))) {
    throw new ProposalRefused("the handover plan changed while proposing; try again");
  }
  await ctx.issues.update(handover.planIssueId, { status: "in_review" }, companyId, actor);
  return { planIssueId: handover.planIssueId, taskIds };
}
