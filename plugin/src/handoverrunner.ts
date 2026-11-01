import type { PluginContext } from "@paperclipai/plugin-sdk";
import { MAX_TASKS_PER_HANDOVER, parseSettings, type Person, type PluginSettings } from "./config.js";
import { decideHandover, OPEN_STATUSES, windowOf, type HandoverDecision, type HandoverRun, type StepClose, type TaskLimitsSeen } from "./handover.js";
import { handoverClock } from "./schedule.js";
import { claimRun, getLatestDoneRun, getOpenRun, getRun, setTaskOutcome, spentSince, stampTasks, updateRun } from "./handoverstore.js";
import { createBriefing } from "./briefing.js";
import { earlierBriefingTaskIds, getBriefing } from "./briefstore.js";
import type { HandoverClock } from "./schedule.js";
import { randomUUID } from "node:crypto";
import { ensureTaskRow, getTaskRow } from "./eventlog.js";
import { HANDOVER_TASK_ORIGIN, PLAN_ORIGIN } from "./ids.js";
import { openClaims, recordClaims, recordOverlap, releaseClaims } from "./claimstore.js";
import { preHandoverCheck, type Areas, type Overlap } from "./prehandover.js";
import { readAreas } from "./repoareas.js";
import { parseProposal, ProposalRefused } from "./proposal.js";
import { taskWorkspaceSettings } from "./workspace.js";
import { agentProblems } from "./isolation.js";
import { TOOL_PROPOSE } from "./tools.js";
import { assertTier } from "./tiers.js";
import { recoverInterruptedActions } from "./links.js";
import {
  briefComment,
  insertNote,
  noteForTask,
  notesOf,
  notesOfRun,
  parseNoteInput,
  queuedTaskIds,
  startQueuedNote,
  ticketDigest,
  withdrawNote,
  type LimitBounds,
  type NoteInput,
  type NoteSchedule,
} from "./notes.js";

export { ProposalRefused };

let lastCompanies: Array<{ id: string }> = [];

/**
 * The companies to tick. This call is made outside any host request (from the
 * ticker loop), and Paperclip 2026.1012.0 refuses such a call while another
 * request is in flight ("invalid invocation scope"; found by the live tests).
 * So it is retried briefly, and otherwise the last list that worked is used.
 */
export async function listCompanies(ctx: PluginContext, pause = (ms: number) => new Promise((r) => setTimeout(r, ms))): Promise<Array<{ id: string }>> {
  let failure: unknown;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      lastCompanies = (await ctx.companies.list()).map((c) => ({ id: c.id }));
      return lastCompanies;
    } catch (err) {
      failure = err;
      await pause(250 * attempt);
    }
  }
  if (lastCompanies.length > 0) return lastCompanies;
  throw failure;
}

/** Run one tick for every company that has valid plugin settings. */
export async function tickAll(ctx: PluginContext, now: Date): Promise<void> {
  const companies = await listCompanies(ctx);
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
  // Approve and Reject clicks that a crash interrupted (spec gap 27).
  await recoverInterruptedActions(ctx, settings, companyId, now).catch((err) =>
    ctx.logger.error("could not recover interrupted links", { companyId, error: err instanceof Error ? err.message : "unknown" }),
  );
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

/** How many tasks one handover of this person may have. */
export const taskLimit = (person: Person) => Math.min(person.maxTasksPerHandover, MAX_TASKS_PER_HANDOVER);

/**
 * The bounds of a note's own limits. Time: up to the handover's length; the
 * default lets a task use its step time and every retry. Budget: up to the
 * person's cap per handover, which is also the default.
 */
export function limitBounds(settings: PluginSettings, person: Person): LimitBounds {
  const h = settings.handover;
  const maxMinutes = h.handoverLengthHours * 60;
  return {
    defaultMinutes: Math.min(h.stepTimeoutMinutes * (h.maxRetries + 1), maxMinutes),
    maxMinutes,
    defaultBudgetCents: person.handoverBudgetCapCents,
    maxBudgetCents: person.handoverBudgetCapCents,
  };
}

// ---------------------------------------------------------------- the owner hands over

/** What the owner sent from their Hand over page. */
export interface HandoverRequest {
  when: NoteSchedule;
  tasks: NoteInput[];
}

/** Read the page's request. Anything that is not a valid list of the owner's tickets is refused, never guessed. */
export function parseHandoverRequest(body: Record<string, unknown>, settings: PluginSettings, person: Person): HandoverRequest | string {
  const when = body.when === undefined ? "now" : body.when;
  if (when !== "now" && when !== "scheduled") return "choose Hand over now or Hand over at my scheduled time";
  const raw = body.tasks;
  if (!Array.isArray(raw) || raw.length === 0) return "choose at least one ticket";
  if (raw.length > taskLimit(person)) return `choose at most ${taskLimit(person)} ticket(s)`;
  const bounds = limitBounds(settings, person);
  const seen = new Set<string>();
  const tasks: NoteInput[] = [];
  for (const [i, entry] of raw.entries()) {
    const note = parseNoteInput((typeof entry === "object" && entry !== null ? entry : {}) as Record<string, unknown>, bounds);
    if (typeof note === "string") return `ticket ${i + 1}: ${note}`;
    if (seen.has(note.issueId)) return `ticket ${i + 1}: chosen twice`;
    seen.add(note.issueId);
    tasks.push(note);
  }
  return { when, tasks };
}

export type HandoverResult =
  | { ok: true; when: NoteSchedule; handoverKey: string | null; taskIds: string[]; message: string; notes: string[] }
  | { ok: false; message: string; overlaps?: string[] };

const why = (o: Overlap) =>
  o.kind === "area"
    ? `\`${o.claim}\` is in ${o.keeper.email}'s area (CODEOWNERS line ${o.rule.line})`
    : `\`${o.claim}\` overlaps \`${o.otherClaim}\`, which ${o.keeper.email}'s task "${o.other.title}" already holds`;

/**
 * The owner's tap on Hand over: exactly these tickets, with exactly these notes.
 * The tap is the approval, so there is no plan step. Everything is checked before
 * anything changes: each ticket must be the owner's agent's, in backlog, and not
 * already waiting; the pre-handover check must find no teammate's area or claim.
 * If anything fails, nothing is handed over.
 *  - "now": a handover starts at once, already approved, with exactly these tasks.
 *  - "scheduled": the notes wait for the owner's next scheduled window, and that
 *    handover runs exactly the notes waiting for it.
 */
export async function handOver(ctx: PluginContext, companyId: string, settings: PluginSettings, person: Person, request: HandoverRequest, now: Date): Promise<HandoverResult> {
  assertTier(request.when === "now" ? "start-handover-now" : "queue-handover", "needs-tap");
  if (request.when === "now") {
    const open = await getOpenRun(ctx.db, companyId, person.email);
    if (open) return { ok: false, message: `a handover is already in progress (${open.status.replace("_", " ")})` };
  } else {
    const waiting = (await notesOf(ctx.db, companyId, person.email, "queued")).length;
    if (waiting + request.tasks.length > taskLimit(person)) {
      return { ok: false, message: `${waiting} ticket(s) already wait for your scheduled handover; at most ${taskLimit(person)} in all` };
    }
  }
  if (!(await agentIsSafe(ctx, settings, companyId, person))) return { ok: false, message: "your agent is not locked down yet (see the plugin's route audit)" };

  const queued = await queuedTaskIds(ctx.db, companyId);
  const issues: Array<NonNullable<Awaited<ReturnType<typeof ctx.issues.get>>>> = [];
  for (const t of request.tasks) {
    const issue = await ctx.issues.get(t.issueId, companyId);
    if (!issue || issue.assigneeAgentId !== person.agentId) return { ok: false, message: "you can only hand over tickets assigned to your own agent" };
    if (issue.status !== "backlog") return { ok: false, message: `ticket ${issue.identifier ?? issue.id} is not in backlog` };
    if (queued.has(issue.id)) return { ok: false, message: `ticket ${issue.identifier ?? issue.id} already waits for your scheduled handover` };
    issues.push(issue);
  }

  // The pre-handover check: a ticket that reaches into a teammate's area or claims is not handed over.
  const projectId = settings.handover.projectId ?? issues.find((i) => i.projectId)?.projectId ?? null;
  let areas: Areas | null;
  let areaNotes: string[];
  try {
    ({ areas, notes: areaNotes } = await projectAreas(ctx, settings, companyId, projectId));
  } catch (err) {
    if (err instanceof ProposalRefused) return { ok: false, message: err.message };
    throw err;
  }
  const titleOf = async (taskId: string) => (await ctx.issues.get(taskId, companyId))?.title ?? taskId;
  const verdicts = preHandoverCheck(person, settings.people, issues.map((i, n) => ({ title: i.title, claims: request.tasks[n]!.claims })), await openClaims(ctx.db, companyId, titleOf), areas);
  const overlaps = verdicts.flatMap((v, n) => (v.overlap ? [{ v, overlap: v.overlap, issue: issues[n]! }] : []));
  if (overlaps.length > 0) {
    const refusedKey = `refused:${now.toISOString().slice(0, 19)}`;
    for (const o of overlaps) {
      await recordOverlap(ctx.db, { id: randomUUID(), companyId, handoverKey: refusedKey, owner: person.email, title: o.v.title, ticketId: o.issue.id, overlap: o.overlap });
    }
    return {
      ok: false,
      message: "Nothing was handed over: a ticket reaches into a teammate's files. Agree with them first, or change its files.",
      overlaps: overlaps.map((o) => `"${o.v.title}": ${why(o.overlap)}.`),
    };
  }

  // The notes first (the record of what the owner asked for), then the run, then claims and briefs.
  const handoverKey = request.when === "now" ? now.toISOString().slice(0, 19) : null;
  for (const [n, t] of request.tasks.entries()) {
    const issue = issues[n]!;
    await insertNote(ctx.db, {
      companyId,
      owner: person.email,
      agentId: person.agentId,
      taskId: issue.id,
      source: "owner",
      status: request.when === "now" ? "handed_over" : "queued",
      schedule: request.when,
      handoverKey,
      title: issue.title,
      what: t.what,
      doneWhen: t.doneWhen,
      claims: t.claims,
      maxMinutes: t.maxMinutes,
      budgetCents: t.budgetCents,
      ticketDigest: ticketDigest(issue.title, issue.description),
      submittedBy: person.email,
      submittedAt: now,
    });
  }
  // Drafts for these tickets (e.g. the agent's suggestions) are used up by the owner's own note.
  for (const d of await notesOf(ctx.db, companyId, person.email, "draft")) {
    if (issues.some((i) => i.id === d.taskId)) await withdrawNote(ctx.db, d.id, "draft");
  }
  const taskIds = issues.map((i) => i.id);
  if (handoverKey) {
    const endsAt = new Date(now.getTime() + settings.handover.handoverLengthHours * 3600_000);
    if (!(await claimRun(ctx.db, { companyId, owner: person.email, agentId: person.agentId, handoverKey, kind: "now", startsAt: now, endsAt, taskIds }))) {
      return { ok: false, message: "a handover was just started; try again in a moment" };
    }
  }
  for (const [n, t] of request.tasks.entries()) {
    const issue = issues[n]!;
    await ensureTaskRow(ctx.db, { taskId: issue.id, companyId, owner: person.email, agent: person.agentId, taskKind: "task" });
    await recordClaims(ctx.db, issue.id, t.claims);
    // A ticket the owner wrote in Paperclip may lack its own worktree: give it one before work starts.
    if (!issue.executionWorkspaceId) await ctx.issues.update(issue.id, { executionWorkspaceSettings: taskWorkspaceSettings() }, companyId);
    await ctx.issues.createComment(issue.id, briefComment(person.email, { ...t, schedule: request.when }), companyId);
  }
  // The owner's tap is the approval: proposed and approved at the same moment.
  await stampTasks(ctx.db, taskIds, "proposed_at", now);
  await stampTasks(ctx.db, taskIds, "approved_at", now);
  if (handoverKey) {
    await tickPerson(ctx, companyId, settings, person, now);
    return { ok: true, when: "now", handoverKey, taskIds, message: `Handed over ${taskIds.length} task(s). Your agent starts now.`, notes: warnings(areaNotes) };
  }
  const clock = scheduleOf(settings, person, now);
  const at = `${String(person.handoverStartHour).padStart(2, "0")}:00 ${person.timezone}`;
  return {
    ok: true,
    when: "scheduled",
    handoverKey: null,
    taskIds,
    message: `Handed over ${taskIds.length} task(s) for your scheduled handover at ${at}${clock.phase === "window" ? " (it is running now, so they start in this one)" : ""}.`,
    notes: warnings(areaNotes),
  };
}

/** Only the warnings are worth the owner's attention after a hand-over (e.g. GitHub teams in CODEOWNERS). */
const warnings = (notes: string[]) => notes.filter((n) => n.startsWith("WARNING"));

/** Take back everything waiting for the scheduled handover (only the owner, before it starts). */
export async function withdrawQueued(ctx: PluginContext, companyId: string, person: Person): Promise<{ ok: true; withdrawn: number; message: string }> {
  let withdrawn = 0;
  for (const n of await notesOf(ctx.db, companyId, person.email, "queued")) {
    if (!(await withdrawNote(ctx.db, n.id, "queued"))) continue;
    withdrawn += 1;
    await releaseClaims(ctx.db, [n.taskId]);
    await ctx.issues.createComment(n.taskId, `${person.email} took this task back before the scheduled handover. It will not run.`, companyId);
  }
  return { ok: true, withdrawn, message: withdrawn ? `Took back ${withdrawn} task(s). Nothing will run for them.` : "Nothing was waiting." };
}

// ---------------------------------------------------------------- the tick

export async function tickPerson(ctx: PluginContext, companyId: string, settings: PluginSettings, person: Person, now: Date): Promise<HandoverDecision> {
  const clock = scheduleOf(settings, person, now);
  const decision = await decideAndApply(ctx, companyId, settings, person, clock, now);
  // Once a handover is done (possibly just now), build its handback email once.
  await maybeBrief(ctx, companyId, settings, person, clock, now);
  return decision;
}

async function decideAndApply(ctx: PluginContext, companyId: string, settings: PluginSettings, person: Person, clock: HandoverClock, now: Date): Promise<HandoverDecision> {
  const run = (await getOpenRun(ctx.db, companyId, person.email)) ?? (await getRun(ctx.db, companyId, person.email, clock.handoverKey));
  // A finished scheduled handover for this date stays finished: one per person per day.
  if (run && !OPEN_STATUSES.includes(run.status)) return { kind: "none" };

  // Notes waiting for this scheduled window, or already moved into it by a tick that stopped halfway.
  const queuedNotes = run
    ? 0
    : (await notesOf(ctx.db, companyId, person.email, "queued")).length + (await notesOfRun(ctx.db, companyId, person.email, clock.handoverKey)).length;
  // The budget counts from the start of this handover's own window.
  const windowStart = run ? windowOf(run, clock).start : clock.startsAt;
  const currentId = run && run.currentIndex >= 0 ? run.taskIds[run.currentIndex] : undefined;
  const decision = decideHandover(
    run,
    clock,
    {
      currentTaskStatus: currentId ? await taskStatus(ctx, companyId, currentId) : null,
      spentCents: await spentSince(ctx.db, companyId, person.agentId, windowStart < now ? windowStart : now),
      currentTask: run && currentId ? await taskLimitsSeen(ctx, companyId, person, run, currentId, now) : null,
      queuedNotes,
    },
    person,
    settings.handover,
    now,
  );
  await apply(ctx, companyId, settings, person, run, clock, decision, now);
  return decision;
}

/** The current task's note limits and what it used so far (null: no note for this run). */
async function taskLimitsSeen(ctx: PluginContext, companyId: string, person: Person, run: HandoverRun, taskId: string, now: Date): Promise<TaskLimitsSeen | null> {
  const note = await noteForTask(ctx.db, taskId);
  if (!note || note.handoverKey !== run.handoverKey) return null;
  const row = await getTaskRow(ctx.db, taskId);
  const startedAt = row?.started_at ? new Date(String(row.started_at)) : null;
  return {
    maxMinutes: note.maxMinutes,
    budgetCents: note.budgetCents,
    startedAt,
    spentCents: startedAt ? await spentSince(ctx.db, companyId, person.agentId, startedAt < now ? startedAt : now) : 0,
  };
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
 * day after a scheduled handover without work.
 */
async function maybeBrief(ctx: PluginContext, companyId: string, settings: PluginSettings, person: Person, clock: HandoverClock, now: Date): Promise<void> {
  if (!settings.links) return; // fail closed: no signed links, no briefing
  const run = await getLatestDoneRun(ctx.db, companyId, person.email);
  const stillInItsWindow = run?.kind === "scheduled" && now >= windowOf(run, clock).start && now < windowOf(run, clock).end;
  if (run && run.taskIds.length > 0 && !stillInItsWindow) {
    if (!(await getBriefing(ctx.db, companyId, person.email, run.handoverKey))) {
      const carried = await earlierBriefingTaskIds(ctx.db, companyId, person.email, run.handoverKey);
      await createBriefing(ctx, person, settings.links, companyId, run.handoverKey, run, carried, now, settings.people);
      return;
    }
  }
  // The day before today's schedule: a day without a finished handover still gets the undecided tasks.
  const lastDay = previousDate(clock.handoverKey);
  if (run && run.taskIds.length > 0 && run.handoverKey >= lastDay) return;
  if (await getBriefing(ctx.db, companyId, person.email, lastDay)) return;
  const open = await getRun(ctx.db, companyId, person.email, lastDay);
  if (open && OPEN_STATUSES.includes(open.status)) return;
  const carried = await earlierBriefingTaskIds(ctx.db, companyId, person.email, lastDay);
  if (carried.length === 0) return;
  await createBriefing(ctx, person, settings.links, companyId, lastDay, null, carried, now, settings.people);
}

async function taskStatus(ctx: PluginContext, companyId: string, taskId: string | undefined): Promise<string | null> {
  if (!taskId) return null;
  return (await ctx.issues.get(taskId, companyId))?.status ?? null;
}

async function agentIsSafe(ctx: PluginContext, settings: PluginSettings, companyId: string, person: Person): Promise<boolean> {
  return agentProblems(settings, person, await ctx.agents.get(person.agentId, companyId), companyId).length === 0;
}

async function comment(ctx: PluginContext, companyId: string, issueId: string | null, body: string): Promise<void> {
  if (issueId) await ctx.issues.createComment(issueId, body, companyId);
}

/** Where the handover's own notices go: its plan ticket (old handovers) or its first task. */
const noticeTicket = (run: HandoverRun) => run.planIssueId ?? run.taskIds[0] ?? null;

async function apply(
  ctx: PluginContext,
  companyId: string,
  settings: PluginSettings,
  person: Person,
  run: HandoverRun | null,
  clock: HandoverClock,
  d: HandoverDecision,
  now: Date,
): Promise<void> {
  switch (d.kind) {
    case "none":
      return;

    case "start-queued": {
      // Exactly the notes the owner queued, nothing else. The agent never chose them.
      if (!(await agentIsSafe(ctx, settings, companyId, person))) {
        ctx.logger.warn("scheduled handover not started: agent is not locked down", { companyId, owner: person.email });
        return;
      }
      const key = clock.handoverKey;
      for (const n of await notesOf(ctx.db, companyId, person.email, "queued")) await startQueuedNote(ctx.db, n.id, key);
      const notes = await notesOfRun(ctx.db, companyId, person.email, key);
      const taskIds = [...new Set(notes.map((n) => n.taskId))];
      if (taskIds.length === 0) return;
      await claimRun(ctx.db, { companyId, owner: person.email, agentId: person.agentId, handoverKey: key, kind: "scheduled", startsAt: clock.startsAt, endsAt: clock.endsAt, taskIds });
      return;
    }

    case "expire": {
      if (!run || !(await updateRun(ctx.db, run, { status: "expired", stopReason: d.reason }))) return;
      await releaseClaims(ctx.db, run.taskIds);
      await comment(ctx, companyId, noticeTicket(run), `No handover work: ${d.reason}.`);
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
      await comment(ctx, companyId, nextId, "Handover paused: the agent is no longer locked down (see route-audit).");
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
      currentId ?? noticeTicket(run),
      `Handover stopped: its budget cap of ${person.handoverBudgetCapCents} cents was reached. The agent is paused; resume it in Paperclip.`,
    );
  } else if (run.planIssueId) {
    await comment(ctx, companyId, run.planIssueId, `Handover finished: ${then.finish}.`);
  }
}

// ---------------------------------------------------------------- help me plan (off by default)

/**
 * Owner areas for the pre-handover check, from the project's primary workspace.
 * No project or workspace: no areas (claims are still compared). A workspace that
 * cannot be read refuses: the check never passes on a guess.
 */
export async function projectAreas(
  ctx: PluginContext,
  settings: PluginSettings,
  companyId: string,
  projectId: string | null,
): Promise<{ areas: Areas | null; notes: string[]; teams?: Array<{ team: string; lines: number[] }> }> {
  const id = settings.handover.projectId ?? projectId;
  if (!id) return { areas: null, notes: ["No project is set, so owner areas are unknown; only claims were compared."] };
  const ws = await ctx.projects.getPrimaryWorkspace(id, companyId);
  if (!ws?.path) return { areas: null, notes: ["The project has no repository folder, so owner areas are unknown; only claims were compared."] };
  for (const ref of ws.defaultRef ? [ws.defaultRef, "HEAD"] : ["HEAD"]) {
    try {
      return await readAreas(ws.path, ref);
    } catch {
      // try the next ref
    }
  }
  throw new ProposalRefused("the project's repository could not be read for the pre-handover check");
}

const OPEN_TICKET = new Set(["backlog", "todo", "in_progress", "in_review", "blocked"]);

/** The agent's open "suggest tasks" ticket, if the owner asked for one. */
async function openSuggestionTicket(ctx: PluginContext, companyId: string, person: Person) {
  const plans = await ctx.issues.list({ companyId, assigneeAgentId: person.agentId, originKind: PLAN_ORIGIN, limit: 20 });
  return plans.find((p) => OPEN_TICKET.has(p.status) && p.status !== "in_review") ?? null;
}

/**
 * "Help me plan": the owner asks their agent to suggest tasks. Off unless the
 * owner's settings turn it on. The agent's answer is only drafts on the owner's
 * Hand over page: nothing runs until the owner hands them over.
 */
export async function askForSuggestions(ctx: PluginContext, companyId: string, settings: PluginSettings, person: Person): Promise<{ ok: boolean; message: string; planIssueId?: string }> {
  if (!person.helpMePlan) return { ok: false, message: "Help me plan is off for you. You choose the tasks; ask the team's admin to turn it on if you want suggestions." };
  if (!(await agentIsSafe(ctx, settings, companyId, person))) return { ok: false, message: "your agent is not locked down yet (see the plugin's route audit)" };
  if (await openSuggestionTicket(ctx, companyId, person)) return { ok: false, message: "your agent is already working on suggestions" };
  const backlog = await ctx.issues.list({ companyId, assigneeAgentId: person.agentId, status: "backlog", limit: 20 });
  const waiting = backlog.length ? `\n\nTickets already waiting for you (suggest them by issueId):\n${backlog.map((i) => `- ${i.identifier ?? i.id} ${i.title} (issueId ${i.id})`).join("\n")}` : "";
  const plan = await ctx.issues.create({
    companyId,
    ...(settings.handover.projectId ? { projectId: settings.handover.projectId } : {}),
    title: `Suggest tasks for ${person.email}`,
    description:
      `${person.email} asked for suggestions. Suggest up to ${taskLimit(person)} task(s) with the \`${TOOL_PROPOSE}\` tool: ` +
      "for each, what to do, the files and folders it may change (claims), and how your owner will know it is done (doneWhen). " +
      `Your suggestions are only drafts. ${person.email} edits them and hands over what they choose; nothing runs before that, and you do not start any work from this ticket.${waiting}`,
    status: "todo",
    assigneeAgentId: person.agentId,
    originKind: PLAN_ORIGIN,
  });
  return { ok: true, message: "Asked your agent for suggestions. They appear on this page as drafts; nothing runs until you hand them over.", planIssueId: plan.id };
}

export interface SuggestResult {
  taskIds: string[];
  message: string;
}

/**
 * The agent's suggestions (the propose tool). Only when the owner turned on Help
 * me plan and asked: each becomes a backlog ticket with a draft note for the
 * owner. No run, no claims, no approval request: the owner's tap does that.
 */
export async function suggestTasks(
  ctx: PluginContext,
  settings: PluginSettings,
  person: Person,
  run: { companyId: string; agentId: string; runId: string; projectId?: string | null },
  params: unknown,
): Promise<SuggestResult> {
  const companyId = run.companyId;
  if (!person.helpMePlan) throw new ProposalRefused("your owner chooses the work; Help me plan is off, so you cannot suggest tasks");
  const plan = await openSuggestionTicket(ctx, companyId, person);
  if (!plan) throw new ProposalRefused("your owner has not asked for suggestions");
  const tasks = parseProposal(params, person);

  const existing = new Map<string, NonNullable<Awaited<ReturnType<typeof ctx.issues.get>>>>();
  for (const t of tasks) {
    if (!("issueId" in t)) continue;
    const issue = await ctx.issues.get(t.issueId, companyId);
    if (!issue || issue.assigneeAgentId !== person.agentId) throw new ProposalRefused("you can only suggest tickets assigned to you");
    if (issue.status !== "backlog") throw new ProposalRefused(`ticket ${issue.identifier ?? issue.id} is not in backlog`);
    existing.set(t.issueId, issue);
  }

  // New suggestions replace older ones the owner has not used.
  for (const d of await notesOf(ctx.db, companyId, person.email, "draft")) if (d.source === "agent") await withdrawNote(ctx.db, d.id, "draft");

  const bounds = limitBounds(settings, person);
  const projectId = settings.handover.projectId ?? plan.projectId ?? run.projectId ?? null;
  const actor = { actorAgentId: run.agentId, actorRunId: run.runId };
  const taskIds: string[] = [];
  for (const t of tasks) {
    const issue =
      "issueId" in t
        ? existing.get(t.issueId)!
        : await ctx.issues.create({
            companyId,
            ...(projectId ? { projectId } : {}),
            title: t.title,
            description: `${t.description ? `${t.description}\n\n` : ""}Suggested by ${person.email}'s agent. It runs only if ${person.email} hands it over.`,
            status: "backlog",
            assigneeAgentId: person.agentId,
            originKind: HANDOVER_TASK_ORIGIN,
            executionWorkspaceSettings: taskWorkspaceSettings(),
            actor,
          });
    await insertNote(ctx.db, {
      companyId,
      owner: person.email,
      agentId: person.agentId,
      taskId: issue.id,
      source: "agent",
      status: "draft",
      schedule: null,
      handoverKey: null,
      title: issue.title,
      what: ("description" in t && t.description) || issue.description || issue.title,
      doneWhen: t.doneWhen,
      claims: t.claims,
      maxMinutes: bounds.defaultMinutes,
      budgetCents: bounds.defaultBudgetCents,
      ticketDigest: null,
      submittedBy: null,
      submittedAt: null,
    });
    taskIds.push(issue.id);
  }
  await ctx.issues.createComment(plan.id, `Suggested ${taskIds.length} task(s). They wait as drafts on ${person.email}'s Hand over page; nothing runs until ${person.email} hands them over.`, companyId, { authorAgentId: run.agentId });
  await ctx.issues.update(plan.id, { status: "done" }, companyId, actor);
  return { taskIds, message: `Suggested ${taskIds.length} task(s) as drafts. Nothing runs until ${person.email} hands them over; do not start them.` };
}
