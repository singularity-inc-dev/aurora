import type { HandoverStatus, InviteCheck, LinkCheck, LinkOutcome } from "./paperclip.ts";
import type { JoinOutcome } from "./join.ts";
import { MAX_PASSWORD, MIN_PASSWORD } from "./join.ts";

export const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

function page(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title><style>body{font-family:system-ui,sans-serif;max-width:32rem;margin:3rem auto;padding:0 1rem;line-height:1.5}
button{font-size:1rem;padding:.6rem 1.2rem}input{font-size:1rem;width:100%;padding:.4rem;box-sizing:border-box}label{display:block;margin-top:.8rem}.muted{color:#666}</style></head>
<body><h1>${esc(title)}</h1>${body}</body></html>`;
}

const taskName = (c: LinkCheck) => (c.task ? `${c.task.identifier ? `${c.task.identifier} ` : ""}${c.task.title}` : "this task");

/** Forms post back to the address they were opened at (works behind a path prefix). */
const form = (inner: string) => `<form method="post">${inner}</form>`;

/** What a person sees when they open a link. Opening never changes anything. */
export function confirmPage(check: LinkCheck, error: string | null = null): string {
  if (!check.ok) return page("Link not usable", `<p>${esc(check.message)}</p>`);
  const err = error ? `<p><strong>${esc(error)}</strong></p>` : "";
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
  proposing: "your agent is planning",
  awaiting_approval: "the plan waits for your approval in Paperclip",
  approved: "approved, starting",
  running: "your agent is working",
  finished: "finished",
  budget_stopped: "stopped at its budget cap",
  rejected: "plan rejected",
  expired: "ended without work",
};

/** Hand over now: the signed-in owner's own page. */
export function handoverPage(status: HandoverStatus, note: string | null = null): string {
  if (!status.ok) return page("Hand over now", `<p>${esc(status.message ?? "You are not on the team.")}</p>`);
  const open = (status.handovers ?? []).find((h) => ["proposing", "awaiting_approval", "approved", "running"].includes(h.status));
  const recent = (status.handovers ?? [])
    .map((h) => `<li>${esc(h.handoverKey.replace("T", " "))}${h.kind === "now" ? " UTC (hand over now)" : " (scheduled)"}: ${esc(STATUS_WORDS[h.status] ?? h.status)}</li>`)
    .join("");
  const hour = String(status.handoverStartHour ?? 0).padStart(2, "0");
  return page(
    "Hand over now",
    `${note ? `<p><strong>${esc(note)}</strong></p>` : ""}<p>Signed in as <strong>${esc(status.email ?? "")}</strong>. Your scheduled handover is at ${hour}:00 (${esc(status.timezone ?? "")}).</p>
${open ? `<p>A handover is in progress: ${esc(STATUS_WORDS[open.status] ?? open.status)}.</p>` : form(`<p><button type="submit">Hand over now</button></p>`)}
<p class="muted">Your agent then chooses up to three tasks (your limit), from tickets already assigned to it or new ones it writes, and proposes them on a plan ticket in Paperclip. Nothing runs until the plan is approved there; anyone signed in to Paperclip as a person can approve it, not only you. Work starts as soon as it is approved. Nothing shared changes until you approve each result in your handback email.</p>
${recent ? `<h2>Recent handovers</h2><ul>${recent}</ul>` : ""}`,
  );
}

export function signInFirstPage(signInUrl: string): string {
  return page("Hand over now", `<p>Please <a href="${esc(signInUrl)}">sign in to Paperclip</a> first, then open this page again.</p>`);
}

export function errorPage(message: string): string {
  return page("Something went wrong", `<p>${esc(message)}</p>`);
}
