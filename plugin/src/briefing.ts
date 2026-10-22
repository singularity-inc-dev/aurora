import type { PluginContext } from "@paperclipai/plugin-sdk";
import type { LinkSettings, Person } from "./config.js";
import { getTaskRow } from "./eventlog.js";
import { getPullRequest, insertAction, insertBriefing, newId, type Briefing, type BriefingItem, type Category } from "./briefstore.js";
import { isClean, revParse, shortStat } from "./merge.js";
import type { NightRun } from "./night.js";
import { actionsIn } from "./tiers.js";
import { signLink, type LinkKind } from "./tokens.js";

/** Facts about one task at briefing time (gathered from Paperclip, the event log and git). */
export interface TaskFacts {
  taskId: string;
  identifier: string | null;
  title: string;
  issueStatus: string | null;
  outcome: string | null;
  /** Link action holding the task's decision (an approval in progress or waiting for review). */
  decisionActionId: string | null;
  startedAt: unknown;
  checksResult: string | null;
  checksHead: string | null;
  worktree: { cwd: string; branch: string; baseRef: string } | null;
  branchHead: string | null;
  clean: boolean;
  summary: string;
}

export interface Classified {
  category: Category;
  checks: string;
  reason: string | null;
  /** Only Ready tasks can be approved; every task can be rejected. */
  approvable: boolean;
}

/**
 * Ready only when the task finished in its own worktree, every change is
 * committed, and the checks passed on exactly the commit the owner will approve.
 */
export function classify(f: TaskFacts): Classified {
  const checks = f.checksResult ? `checks ${f.checksResult}${f.checksHead ? ` on ${f.checksHead.slice(0, 7)}` : ""}` : "checks not run";
  const no = (category: Category, reason: string): Classified => ({ category, checks, reason, approvable: false });
  if (f.outcome === "failed") return no("failed", "timed out after its retries");
  if (f.outcome === "blocked") return no("blocked", "stopped by the night routine");
  if (!f.startedAt) return no("blocked", "not started tonight");
  if (f.issueStatus && !["done", "in_review"].includes(f.issueStatus)) return no("blocked", `agent left it ${f.issueStatus}`);
  if (!f.worktree || !f.branchHead) return no("blocked", "no worktree for this task");
  if (!f.clean) return no("blocked", "uncommitted changes in the worktree");
  if (f.checksResult !== "passed") return no("blocked", f.checksResult === "failed" ? "checks failed" : "checks not run");
  if (f.checksHead !== f.branchHead) return no("blocked", "checks did not run on the latest commit");
  return { category: "ready", checks, reason: null, approvable: true };
}

async function gatherFacts(ctx: PluginContext, companyId: string, taskId: string): Promise<TaskFacts> {
  const issue = await ctx.issues.get(taskId, companyId);
  const ev = (await getTaskRow(ctx.db, taskId)) ?? {};
  const facts: TaskFacts = {
    taskId,
    identifier: issue?.identifier ?? null,
    title: issue?.title ?? "(missing ticket)",
    issueStatus: issue?.status ?? null,
    outcome: (ev.outcome as string | null) ?? null,
    decisionActionId: (ev.decision_action_id as string | null) ?? null,
    startedAt: ev.started_at ?? null,
    checksResult: (ev.checks_result as string | null) ?? null,
    checksHead: (ev.checks_head as string | null) ?? null,
    worktree: null,
    branchHead: null,
    clean: false,
    summary: issue?.title ?? "(missing ticket)",
  };
  const ws = issue?.executionWorkspaceId ? await ctx.executionWorkspaces.get(issue.executionWorkspaceId, companyId) : null;
  const cwd = ws?.cwd ?? ws?.path ?? null;
  if (ws && ws.providerType === "git_worktree" && cwd && ws.branchName && ws.baseRef) {
    facts.worktree = { cwd, branch: ws.branchName, baseRef: ws.baseRef };
    facts.branchHead = await revParse(cwd, `refs/heads/${ws.branchName}`);
    facts.clean = await isClean(cwd);
    if (facts.branchHead) facts.summary = `${facts.title}: ${await shortStat(cwd, ws.baseRef, facts.branchHead)}`;
  }
  return facts;
}

/**
 * Build and store the morning briefing for one person and one night. Safe to
 * call twice. Tasks from earlier emails that are still undecided come back with
 * fresh links; tasks whose pull request waits for review are listed without links.
 */
export async function createBriefing(
  ctx: PluginContext,
  person: Person,
  links: LinkSettings,
  companyId: string,
  nightDate: string,
  run: NightRun | null,
  carriedTaskIds: string[],
  now: Date,
): Promise<Briefing | null> {
  const briefingId = newId();
  const expiresAt = new Date(now.getTime() + links.expiresMinutes * 60_000);
  const items: BriefingItem[] = [];
  const actions: Array<Parameters<typeof insertAction>[1]> = [];
  const tonight = run?.taskIds ?? [];
  const taskIds = [...tonight, ...carriedTaskIds.filter((id) => !tonight.includes(id))];
  for (const taskId of taskIds) {
    const f = await gatherFacts(ctx, companyId, taskId);
    if (f.outcome === "accepted" || f.outcome === "rejected") continue;
    const carried = !tonight.includes(taskId);
    if (f.decisionActionId) {
      // Approved already: either waiting for review on GitHub, or still being processed.
      const pr = await getPullRequest(ctx.db, taskId);
      if (pr?.state === "waiting") {
        items.push({
          taskId,
          identifier: f.identifier,
          title: f.title,
          category: "waiting",
          summary: f.summary,
          checks: `pull request #${pr.number} waiting for review`,
          reason: pr.reason,
          approveActionId: null,
          rejectActionId: null,
          prUrl: pr.url,
          carried,
        });
      }
      continue;
    }
    const c = classify(f);
    const action = (kind: LinkKind) => {
      const a = {
        id: newId(),
        companyId,
        owner: person.email,
        taskId,
        kind,
        briefingId,
        workspaceCwd: f.worktree?.cwd ?? null,
        branch: f.worktree?.branch ?? null,
        baseRef: f.worktree?.baseRef ?? null,
        expectedHead: kind === "approve" ? f.branchHead : null,
        expiresAt,
      };
      actions.push(a);
      return a.id;
    };
    items.push({
      taskId,
      identifier: f.identifier,
      title: f.title,
      category: c.category,
      summary: f.summary,
      checks: c.checks,
      reason: c.reason,
      approveActionId: c.approvable ? action("approve") : null,
      rejectActionId: action("reject"),
      carried,
    });
  }
  if (!run && items.length === 0) return null;
  const notes = run?.status === "budget_stopped" ? ["Your agent hit tonight's budget cap and was paused. Resume it in Paperclip when you are ready."] : [];
  const briefing = { id: briefingId, companyId, owner: person.email, nightDate, items, notes };
  if (!(await insertBriefing(ctx.db, briefing))) return null;
  for (const a of actions) await insertAction(ctx.db, a);
  return { ...briefing, status: "pending" };
}

export interface RenderedEmail {
  briefingId: string;
  to: string;
  subject: string;
  text: string;
  html: string;
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const SECTIONS: Array<[Category, string]> = [
  ["ready", "Ready"],
  ["blocked", "Blocked"],
  ["failed", "Failed"],
  ["waiting", "Waiting for review"],
];

/** Render a briefing as an email, with freshly signed links (tokens are never stored). */
export function renderBriefing(b: Briefing, links: LinkSettings, secret: string, expiresAt: Date): RenderedEmail {
  const exp = Math.floor(expiresAt.getTime() / 1000);
  const url = (actionId: string, item: BriefingItem, kind: LinkKind) =>
    `${links.baseUrl}/l/${signLink({ v: 1, a: actionId, c: b.companyId, o: b.owner, t: item.taskId, k: kind, e: exp }, secret)}`;
  const count = (c: Category) => b.items.filter((i) => i.category === c).length;
  const waiting = count("waiting");
  const subject = `Your night of ${b.nightDate}: ${count("ready")} ready, ${count("blocked")} blocked, ${count("failed")} failed${waiting ? `, ${waiting} waiting for review` : ""}`;

  const text: string[] = [`Good morning. Here is what your agent did on the night of ${b.nightDate}.`, ""];
  const html: string[] = [`<p>Good morning. Here is what your agent did on the night of ${esc(b.nightDate)}.</p>`];
  for (const note of b.notes) {
    text.push(`Note: ${note}`, "");
    html.push(`<p><strong>Note:</strong> ${esc(note)}</p>`);
  }
  for (const [cat, label] of SECTIONS) {
    const items = b.items.filter((i) => i.category === cat);
    if (cat === "waiting" && items.length === 0) continue;
    text.push(`${label.toUpperCase()} (${items.length})`);
    html.push(`<h2>${label} (${items.length})</h2>`);
    if (items.length === 0) {
      text.push("  none", "");
      html.push("<p>None.</p>");
      continue;
    }
    html.push("<ul>");
    for (const i of items) {
      const name = `${i.identifier ? `${i.identifier} ` : ""}${i.summary}`;
      const approve = i.approveActionId ? url(i.approveActionId, i, "approve") : null;
      const reject = i.rejectActionId ? url(i.rejectActionId, i, "reject") : null;
      text.push(`- ${name}`, `  ${i.checks}${i.reason ? ` (${i.reason})` : ""}`);
      if (i.carried) text.push("  From an earlier email; still waiting for your decision.");
      if (i.prUrl) text.push(`  Pull request: ${i.prUrl}`);
      if (approve) text.push(`  Approve: ${approve}`);
      if (reject) text.push(`  Reject: ${reject}`);
      text.push("");
      html.push(
        `<li><p><strong>${esc(name)}</strong><br>${esc(i.checks)}${i.reason ? ` (${esc(i.reason)})` : ""}` +
          (i.carried ? "<br><em>From an earlier email; still waiting for your decision.</em>" : "") +
          `</p><p>` +
          (i.prUrl ? `<a href="${esc(i.prUrl)}">Pull request</a> &nbsp; ` : "") +
          (approve ? `<a href="${esc(approve)}">Approve</a> &nbsp; ` : "") +
          (reject ? `<a href="${esc(reject)}">Reject</a>` : "") +
          `</p></li>`,
      );
    }
    html.push("</ul>");
  }
  const footer = [
    `Links expire ${expiresAt.toISOString().replace("T", " ").slice(0, 16)} UTC and work once. Approve merges only if the branch is unchanged since this email. Anything you have not decided comes back in the next morning's email with fresh links.`,
    `Happens automatically: ${actionsIn("automatic").join(", ")}. Needs your tap: ${actionsIn("needs-tap").join(", ")}. Never: ${actionsIn("never").join(", ")}.`,
  ];
  text.push(...footer);
  html.push(...footer.map((f) => `<p style="color:#666;font-size:12px">${esc(f)}</p>`));
  return { briefingId: b.id, to: b.owner, subject, text: text.join("\n"), html: html.join("\n") };
}
