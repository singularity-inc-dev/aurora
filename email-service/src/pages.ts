import type { HandoverStatus, HandoverTicket, InviteCheck, LinkCheck, LinkOutcome } from "./paperclip.ts";
import type { JoinOutcome } from "./join.ts";
import { MAX_PASSWORD, MIN_PASSWORD } from "./join.ts";

export const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

function page(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title><style>body{font-family:system-ui,sans-serif;max-width:32rem;margin:3rem auto;padding:0 1rem;line-height:1.5}
button{font-size:1rem;padding:.6rem 1.2rem;margin:.2rem 0}input,textarea{font-size:1rem;width:100%;padding:.4rem;box-sizing:border-box}label{display:block;margin-top:.8rem}.muted{color:#666}
fieldset{margin:1rem 0;border:1px solid #ccc;padding:.6rem 1rem}legend{font-weight:600}.pick input{width:auto;margin-right:.4rem}.row{display:flex;gap:.6rem}.row label{flex:1}.ticket{white-space:pre-wrap;color:#444;font-size:.9rem;max-height:8rem;overflow:auto}</style></head>
<body><h1>${esc(title)}</h1>${body}</body></html>`;
}

const taskName = (c: LinkCheck) => (c.task ? `${c.task.identifier ? `${c.task.identifier} ` : ""}${c.task.title}` : "this task");

/** Forms post back to the address they were opened at (works behind a path prefix). */
const form = (inner: string) => `<form method="post">${inner}</form>`;

/** Who is signed in to Paperclip in this browser, as the link pages see it. */
export type Viewer = { email: string } | null;

/**
 * What a person sees when they open a link. Opening never changes anything.
 * Only the task's owner, signed in to Paperclip in this browser, gets the button.
 */
export function confirmPage(check: LinkCheck, error: string | null = null, viewer: Viewer = null, signInUrl = "/"): string {
  if (!check.ok) return page("Link not usable", `<p>${esc(check.message)}</p>`);
  const err = error ? `<p><strong>${esc(error)}</strong></p>` : "";
  const owner = check.owner ?? "";
  if (!viewer || viewer.email !== owner) {
    const who = viewer ? `You are signed in to Paperclip as <strong>${esc(viewer.email)}</strong>. ` : "";
    return page(
      check.kind === "approve" ? "Approve and merge?" : "Reject this task?",
      `<p>${esc(taskName(check))} is ${esc(owner)}'s task. Only ${esc(owner)} can decide it.</p><p>${who}Please <a href="${esc(signInUrl)}">sign in to Paperclip</a> as ${esc(owner)} in this browser, then open this link again.</p>`,
    );
  }
  if (check.kind === "approve") {
    const where = check.github
      ? `<p>Push <strong>${esc(taskName(check))}</strong> to GitHub (${esc(check.github)}), open a pull request and merge it.</p>`
      : `<p>Merge <strong>${esc(taskName(check))}</strong> into the main branch.</p>`;
    return page(
      "Approve and merge?",
      `${where}${err}
${form(`<button type="submit">Approve and merge</button>`)}
<p class="muted">The merge only happens if the branch is unchanged since your email.${check.github ? " If the repository needs a review first, the pull request stays open and waits for it." : ""}</p>`,
    );
  }
  return page(
    "Reject this task?",
    `<p>Reject <strong>${esc(taskName(check))}</strong>. Nothing will be merged.</p>${err}
${form(`<label for="reason">Reason (one line)</label>
<input id="reason" name="reason" maxlength="200" required autofocus><p><button type="submit">Reject</button></p>`)}`,
  );
}

export function resultPage(outcome: { status: LinkOutcome["status"]; message: string }): string {
  const titles: Record<LinkOutcome["status"], string> = {
    merged: "Merged",
    rejected: "Rejected",
    waiting: "Waiting for review",
    publish: "Working on it",
    invalid: "Link not usable",
    expired: "Link expired",
    "already-used": "Already done",
    refused: "Not done",
    "needs-reason": "Reason needed",
  };
  return page(titles[outcome.status], `<p>${esc(outcome.message)}</p>`);
}

/** The invite page: name, password and timezone. Opening it changes nothing. */
export function joinPage(check: InviteCheck, error: string | null = null, values: { name?: string; timezone?: string } = {}): string {
  if (!check.ok) return page(check.status === "expired" ? "Invite expired" : check.status === "already-used" ? "Invite already used" : "Invite not usable", `<p>${esc(check.message)}</p>`);
  const err = error ? `<p><strong>${esc(error)}</strong></p>` : "";
  return page(
    "Join your team",
    `<p>You were invited as <strong>${esc(check.email ?? "")}</strong>. This creates your account and your personal agent.</p>${err}
${form(`<label for="name">Your name</label><input id="name" name="name" maxlength="80" required autofocus value="${esc(values.name ?? "")}">
<label for="password">Choose a password (${MIN_PASSWORD}+ characters)</label><input id="password" name="password" type="password" minlength="${MIN_PASSWORD}" maxlength="${MAX_PASSWORD}" required autocomplete="new-password">
<label for="timezone">Your timezone</label><input id="timezone" name="timezone" maxlength="64" value="${esc(values.timezone ?? check.timezone ?? "")}">
<p><button type="submit">Create my account</button></p>`)}
<p class="muted">This link works once.</p>`,
  );
}

export function joinResultPage(outcome: JoinOutcome, signInUrl: string): string {
  if (outcome.ok) return page("You're in", `<p>${esc(outcome.message)}</p><p><a href="${esc(signInUrl)}">Sign in to Paperclip</a> with ${esc(outcome.email)} and your new password.</p>`);
  const titles: Record<Exclude<JoinOutcome["status"], "joined">, string> = {
    invalid: "Invite not usable",
    expired: "Invite expired",
    "already-used": "Invite already used",
    refused: "Not done",
    "needs-input": "Please check the form",
    failed: "Something went wrong",
  };
  return page(titles[outcome.status], `<p>${esc(outcome.message)}</p>`);
}

const STATUS_WORDS: Record<string, string> = {
  proposing: "ended (old plan step)",
  awaiting_approval: "ended (old plan step)",
  approved: "handed over, waiting for its window",
  running: "your agent is working",
  finished: "finished",
  budget_stopped: "stopped at its budget cap",
  rejected: "plan rejected",
  expired: "ended without work",
};

/** What the owner typed, sent back when something was not right (nothing is lost). */
export type HandoverForm = { picked: string[]; values: Record<string, string> };

/** Messages for the top of the page: the outcome, and anything the owner must know. */
export interface HandoverMessage {
  text: string;
  /** Teammates' files a ticket reached into (nothing was handed over). */
  overlaps?: string[];
  notes?: string[];
}

function ticketFields(t: HandoverTicket, status: HandoverStatus, form: HandoverForm | null): string {
  const v = (field: string, fallback = "") => esc(form ? (form.values[`${field}:${t.id}`] ?? "") : fallback);
  const limits = status.limits;
  const picked = form ? form.picked.includes(t.id) : false;
  const name = `${t.identifier ? `${t.identifier} ` : ""}${t.title}`;
  const suggested = t.draft?.source === "agent" ? `<p class="muted">Suggested by your agent. Check every field: what you hand over is what runs.</p>` : "";
  const ticketText = t.description ? `<div class="ticket">${esc(t.description)}</div>` : "";
  return `<fieldset><legend><label class="pick"><input type="checkbox" name="pick" value="${esc(t.id)}"${picked ? " checked" : ""}>${esc(name)}</label></legend>${suggested}${ticketText}
<label for="what:${esc(t.id)}">What to do</label><textarea id="what:${esc(t.id)}" name="what:${esc(t.id)}" rows="3" maxlength="4000">${v("what", t.draft?.what ?? t.description ?? t.title)}</textarea>
<label for="done:${esc(t.id)}">Done when (how you will know it is finished; you judge it)</label><textarea id="done:${esc(t.id)}" name="done:${esc(t.id)}" rows="2" maxlength="1000">${v("done", t.draft?.doneWhen ?? "")}</textarea>
<label for="files:${esc(t.id)}">Files and folders it may change (commas between them; anything else fails the checks)</label><input id="files:${esc(t.id)}" name="files:${esc(t.id)}" maxlength="2000" value="${v("files", t.draft?.files ?? "")}">
<div class="row"><label>Time limit (minutes)<input name="min:${esc(t.id)}" inputmode="numeric" maxlength="4" value="${v("min", String(limits?.defaultMinutes ?? ""))}"></label>
<label>Budget (US cents)<input name="cents:${esc(t.id)}" inputmode="numeric" maxlength="7" value="${v("cents", String(limits?.defaultBudgetCents ?? ""))}"></label></div></fieldset>`;
}

/** The owner's Hand over page: choose tickets, write a note on each, hand them over. */
export function handoverPage(status: HandoverStatus, message: HandoverMessage | string | null = null, form: HandoverForm | null = null): string {
  if (!status.ok) return page("Hand over", `<p>${esc(status.message ?? "You are not on the team.")}</p>`);
  const msg = typeof message === "string" ? { text: message } : message;
  const top = msg
    ? `<p><strong>${esc(msg.text)}</strong></p>` +
      (msg.overlaps?.length ? `<ul>${msg.overlaps.map((o) => `<li>${esc(o)}</li>`).join("")}</ul>` : "") +
      (msg.notes?.length ? msg.notes.map((n) => `<p class="muted">${esc(n)}</p>`).join("") : "")
    : "";
  const open = (status.handovers ?? []).find((h) => ["approved", "running"].includes(h.status));
  const recent = (status.handovers ?? [])
    .map((h) => `<li>${esc(h.handoverKey.replace("T", " "))}${h.kind === "now" ? " UTC (hand over now)" : " (scheduled)"}: ${esc(STATUS_WORDS[h.status] ?? h.status)}</li>`)
    .join("");
  const hour = String(status.handoverStartHour ?? 0).padStart(2, "0");
  const when = `${hour}:00 (${esc(status.timezone ?? "")})`;
  const max = status.maxTasks ?? 1;
  const tickets = status.tickets ?? [];
  const queued = status.queued ?? [];
  const handForm = tickets.length
    ? `<form method="post"><p>Tick up to ${max} ticket(s) and write a note on each. Your agent works on exactly these, in this order, with your note as its brief. It cannot add, swap or rewrite them.</p>
${tickets.map((t) => ticketFields(t, status, form)).join("\n")}
<p><button type="submit" name="action" value="now"${open ? " disabled" : ""}>Hand over now</button> <button type="submit" name="action" value="scheduled">Hand over at my scheduled time (${when})</button></p>
<p class="muted">Your tap is the approval: there is no separate plan to approve. Nothing shared changes until you approve each result in your handback email.${open ? " Hand over now is off while a handover is in progress." : ""}</p></form>`
    : `<p>Your agent has no tickets in Backlog. Write a ticket in Paperclip, assign it to your agent, leave it in Backlog, and it appears here.</p>`;
  const waiting = queued.length
    ? `<h2>Waiting for your scheduled handover at ${when}</h2><ul>${queued.map((q) => `<li>${esc(q.title)} (done when: ${esc(q.doneWhen)})</li>`).join("")}</ul>
<form method="post"><button type="submit" name="action" value="withdraw">Take them back</button></form>`
    : "";
  const help = status.helpMePlan
    ? `<h2>Help me plan</h2><form method="post"><p class="muted">Your agent suggests up to ${max} task(s). They appear above as drafts; nothing runs until you hand them over.</p><button type="submit" name="action" value="suggest">Ask my agent for suggestions</button></form>`
    : "";
  return page(
    "Hand over",
    `${top}<p>Signed in as <strong>${esc(status.email ?? "")}</strong>. Your scheduled handover is at ${when}.</p>
${open ? `<p>A handover is in progress: ${esc(STATUS_WORDS[open.status] ?? open.status)}.</p>` : ""}${handForm}${waiting}${help}
${recent ? `<h2>Recent handovers</h2><ul>${recent}</ul>` : ""}`,
  );
}

export function signInFirstPage(signInUrl: string): string {
  return page("Hand over", `<p>Please <a href="${esc(signInUrl)}">sign in to Paperclip</a> first, then open this page again.</p>`);
}

export function errorPage(message: string): string {
  return page("Something went wrong", `<p>${esc(message)}</p>`);
}
