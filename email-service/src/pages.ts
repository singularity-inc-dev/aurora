import type { LinkCheck, LinkOutcome } from "./paperclip.ts";

export const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

function page(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title><style>body{font-family:system-ui,sans-serif;max-width:32rem;margin:3rem auto;padding:0 1rem;line-height:1.5}
button{font-size:1rem;padding:.6rem 1.2rem}input{font-size:1rem;width:100%;padding:.4rem;box-sizing:border-box}.muted{color:#666}</style></head>
<body><h1>${esc(title)}</h1>${body}</body></html>`;
}

const taskName = (c: LinkCheck) => (c.task ? `${c.task.identifier ? `${c.task.identifier} ` : ""}${c.task.title}` : "this task");

/** What a person sees when they open a link. Opening never changes anything. */
export function confirmPage(check: LinkCheck, action: string, error: string | null = null): string {
  if (!check.ok) return page("Link not usable", `<p>${esc(check.message)}</p>`);
  const err = error ? `<p><strong>${esc(error)}</strong></p>` : "";
  if (check.kind === "approve") {
    return page(
      "Approve and merge?",
      `<p>Merge <strong>${esc(taskName(check))}</strong> into the main branch.</p>${err}
<form method="post" action="${esc(action)}"><button type="submit">Approve and merge</button></form>
<p class="muted">The merge only happens if the branch is unchanged since your email.</p>`,
    );
  }
  return page(
    "Reject this task?",
    `<p>Reject <strong>${esc(taskName(check))}</strong>. Nothing will be merged.</p>${err}
<form method="post" action="${esc(action)}"><label for="reason">Reason (one line)</label>
<input id="reason" name="reason" maxlength="200" required autofocus><p><button type="submit">Reject</button></p></form>`,
  );
}

export function resultPage(outcome: LinkOutcome): string {
  const titles: Record<LinkOutcome["status"], string> = {
    merged: "Merged",
    rejected: "Rejected",
    invalid: "Link not usable",
    expired: "Link expired",
    "already-used": "Already done",
    refused: "Not done",
    "needs-reason": "Reason needed",
  };
  return page(titles[outcome.status], `<p>${esc(outcome.message)}</p>`);
}

export function errorPage(message: string): string {
  return page("Something went wrong", `<p>${esc(message)}</p>`);
}
