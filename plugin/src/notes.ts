import { createHash, randomUUID } from "node:crypto";
import type { PluginDatabaseClient } from "@paperclipai/plugin-sdk";
import { MAX_CLAIMS_PER_TASK, claimsOverlap, normalizeClaim } from "./claims.js";

/**
 * The handover note (ARCHITECTURE.md, data model "HandoverNote"): what the owner
 * writes for each task they hand over. It lives in one place, the plugin's
 * `handover_notes` table. Once the owner taps Hand over it is locked: the agent
 * gets it as its brief, the engine enforces its limits, the checks gate enforces
 * its files, and the handback shows it. Nothing the agent does changes it.
 */
export interface NoteLimits {
  /** Files and folders the task may change (its claims). A change outside them fails the checks. */
  claims: string[];
  /** Total minutes the task may take, retries included. */
  maxMinutes: number;
  /** What the owner's agent may spend on this task, in US cents. */
  budgetCents: number;
}

export interface NoteText {
  /** What to do, in the owner's words. */
  what: string;
  /** How the owner will know it is finished. Shown on the handback; the owner judges it. */
  doneWhen: string;
}

export type NoteSource = "owner" | "agent";
export type NoteStatus = "draft" | "queued" | "handed_over" | "withdrawn";
/** "now": Hand over now. "scheduled": the owner's next scheduled handover window. */
export type NoteSchedule = "now" | "scheduled";

export interface HandoverNote extends NoteText, NoteLimits {
  id: string;
  companyId: string;
  owner: string;
  agentId: string;
  taskId: string;
  source: NoteSource;
  status: NoteStatus;
  schedule: NoteSchedule | null;
  handoverKey: string | null;
  /** The ticket's title when the note was written. */
  title: string;
  /** Fingerprint of the ticket's title and description when it was handed over. */
  ticketDigest: string | null;
  submittedBy: string | null;
  submittedAt: Date | null;
}

export const MAX_WHAT = 4000;
export const MAX_DONE_WHEN = 1000;
export const MIN_MINUTES = 5;

/** The bounds a note's limits must stay within (from the plugin settings and the person). */
export interface LimitBounds {
  defaultMinutes: number;
  maxMinutes: number;
  defaultBudgetCents: number;
  maxBudgetCents: number;
}

/** One task as the owner submits it from the Hand over page. */
export interface NoteInput extends NoteText, NoteLimits {
  issueId: string;
}

const text = (v: unknown) => (typeof v === "string" ? v.replace(/\r\n?/g, "\n").trim() : "");

function wholeNumber(v: unknown): number | null | "bad" {
  if (v === undefined || v === null || (typeof v === "string" && v.trim() === "")) return null;
  const n = typeof v === "number" ? v : typeof v === "string" && /^\d+$/.test(v.trim()) ? Number(v.trim()) : NaN;
  return Number.isSafeInteger(n) ? n : "bad";
}

/** Files may come as a list, or as one text with commas or one per line. */
export function splitFiles(raw: unknown): string[] {
  const parts = Array.isArray(raw) ? raw.flatMap((x) => (typeof x === "string" ? x.split(/[\n,]/) : [""])) : typeof raw === "string" ? raw.split(/[\n,]/) : [];
  return parts.map((f) => f.trim()).filter(Boolean);
}

export function parseClaimList(raw: unknown): string[] | string {
  const files = splitFiles(raw);
  if (files.length === 0) return 'list the files or folders it may change (for example "src/ui/, README.md")';
  if (files.length > MAX_CLAIMS_PER_TASK) return `at most ${MAX_CLAIMS_PER_TASK} files or folders`;
  const claims = new Set<string>();
  for (const f of files) {
    const c = normalizeClaim(f);
    if (!c) return `"${f.slice(0, 80)}" must be a path inside the repository ("*", "?" and "**" allowed)`;
    claims.add(c);
  }
  return [...claims];
}

/**
 * Check one task of the owner's handover. Every field the owner types is checked;
 * nothing is guessed. Time and budget fall back to the defaults when left empty.
 */
export function parseNoteInput(raw: Record<string, unknown>, bounds: LimitBounds): NoteInput | string {
  const issueId = text(raw.issueId);
  if (!issueId || issueId.length > 100) return "no ticket chosen";
  const what = text(raw.what);
  if (!what) return "write what to do";
  if (what.length > MAX_WHAT) return `"What to do" is too long (at most ${MAX_WHAT} characters)`;
  const doneWhen = text(raw.doneWhen);
  if (!doneWhen) return 'write how you will know it is done ("Done when")';
  if (doneWhen.length > MAX_DONE_WHEN) return `"Done when" is too long (at most ${MAX_DONE_WHEN} characters)`;
  const claims = parseClaimList(raw.files ?? raw.claims);
  if (typeof claims === "string") return claims;

  const minutes = wholeNumber(raw.maxMinutes);
  if (minutes === "bad") return "the time limit must be a whole number of minutes";
  const maxMinutes = minutes ?? bounds.defaultMinutes;
  if (maxMinutes < MIN_MINUTES || maxMinutes > bounds.maxMinutes) return `the time limit must be ${MIN_MINUTES} to ${bounds.maxMinutes} minutes`;

  const cents = wholeNumber(raw.budgetCents);
  if (cents === "bad") return "the budget must be a whole number of US cents";
  const budgetCents = cents ?? bounds.defaultBudgetCents;
  if (budgetCents < 1 || budgetCents > bounds.maxBudgetCents) return `the budget must be 1 to ${bounds.maxBudgetCents} cents (your cap per handover)`;

  return { issueId, what, doneWhen, claims, maxMinutes, budgetCents };
}

/** Fingerprint of a ticket's text, to tell the owner if it was changed after they handed it over. */
export function ticketDigest(title: string, description: string | null | undefined): string {
  return createHash("sha256").update(`${title}\n\0\n${description ?? ""}`).digest("hex").slice(0, 32);
}

/** Is this changed file inside the note's files? */
export function fileAllowed(file: string, claims: readonly string[]): boolean {
  return claims.some((c) => claimsOverlap(c, file, { bIsFile: true }));
}

/** The agent's brief: posted on the ticket when it is handed over. The locked copy is the plugin's. */
export function briefComment(owner: string, note: Pick<HandoverNote, "what" | "doneWhen" | "claims" | "maxMinutes" | "budgetCents" | "schedule">): string {
  const lines = [
    `**Handover note from ${owner}** (locked: editing this ticket does not change it).`,
    "",
    `**What to do:** ${note.what}`,
    "",
    `**Done when:** ${note.doneWhen}`,
    "",
    "**Limits:**",
    `- Change only: ${note.claims.map((c) => `\`${c}\``).join(", ")}. A change to any other file fails the checks.`,
    `- Time: ${note.maxMinutes} minutes.`,
    `- Budget: ${note.budgetCents} cents.`,
    "",
    "Do only this task. Commit your work on this ticket's branch, call `run_checks` on this ticket, then mark it done.",
  ];
  if (note.schedule === "scheduled") lines.push("", `It starts in ${owner}'s next scheduled handover, not before.`);
  return lines.join("\n");
}

// ---------------------------------------------------------------- storage

type Db = Pick<PluginDatabaseClient, "namespace" | "execute" | "query">;
const table = (db: Db) => `"${db.namespace}".handover_notes`;

function list(v: unknown): string[] {
  try {
    const parsed = JSON.parse(String(v ?? "[]"));
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

function toNote(row: Record<string, unknown>): HandoverNote {
  const status = String(row.status);
  return {
    id: String(row.id),
    companyId: String(row.company_id),
    owner: String(row.owner),
    agentId: String(row.agent_id),
    taskId: String(row.task_id),
    source: row.source === "agent" ? "agent" : "owner",
    status: (["draft", "queued", "handed_over", "withdrawn"].includes(status) ? status : "withdrawn") as NoteStatus,
    schedule: row.schedule === "now" || row.schedule === "scheduled" ? row.schedule : null,
    handoverKey: (row.handover_key as string | null) ?? null,
    title: String(row.title ?? ""),
    what: String(row.what ?? ""),
    doneWhen: String(row.done_when ?? ""),
    claims: list(row.claims),
    maxMinutes: Number(row.max_minutes),
    budgetCents: Number(row.budget_cents),
    ticketDigest: (row.ticket_digest as string | null) ?? null,
    submittedBy: (row.submitted_by as string | null) ?? null,
    submittedAt: row.submitted_at ? new Date(String(row.submitted_at)) : null,
  };
}

export type NewNote = Omit<HandoverNote, "id" | "submittedAt"> & { id?: string; submittedAt?: Date | null };

export async function insertNote(db: Db, n: NewNote): Promise<string> {
  const id = n.id ?? randomUUID();
  await db.execute(
    `INSERT INTO ${table(db)} (id, company_id, owner, agent_id, task_id, source, status, schedule, handover_key, title, what, done_when, claims, max_minutes, budget_cents, ticket_digest, submitted_by, submitted_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)`,
    [
      id,
      n.companyId,
      n.owner,
      n.agentId,
      n.taskId,
      n.source,
      n.status,
      n.schedule,
      n.handoverKey,
      n.title,
      n.what,
      n.doneWhen,
      JSON.stringify(n.claims),
      n.maxMinutes,
      n.budgetCents,
      n.ticketDigest,
      n.submittedBy,
      n.submittedAt ? n.submittedAt.toISOString() : null,
    ],
  );
  return id;
}

/** A person's notes in the given status, oldest first. */
export async function notesOf(db: Db, companyId: string, owner: string, status: NoteStatus): Promise<HandoverNote[]> {
  const rows = await db.query(`SELECT * FROM ${table(db)} WHERE company_id = $1 AND owner = $2 AND status = $3 ORDER BY created_at`, [companyId, owner, status]);
  return rows.map(toNote);
}

/** The notes handed over in one handover run. */
export async function notesOfRun(db: Db, companyId: string, owner: string, handoverKey: string): Promise<HandoverNote[]> {
  const rows = await db.query(`SELECT * FROM ${table(db)} WHERE company_id = $1 AND owner = $2 AND handover_key = $3 AND status = 'handed_over' ORDER BY created_at`, [
    companyId,
    owner,
    handoverKey,
  ]);
  return rows.map(toNote);
}

/** The note a task was last handed over with (the one that governs it), if any. */
export async function noteForTask(db: Db, taskId: string): Promise<HandoverNote | null> {
  const rows = await db.query(`SELECT * FROM ${table(db)} WHERE task_id = $1 AND status = 'handed_over' ORDER BY created_at DESC LIMIT 1`, [taskId]);
  return rows[0] ? toNote(rows[0]) : null;
}

/** Tickets waiting for the owner's schedule (they cannot be handed over twice). */
export async function queuedTaskIds(db: Db, companyId: string): Promise<Set<string>> {
  const rows = await db.query(`SELECT * FROM ${table(db)} WHERE company_id = $1 AND status = 'queued'`, [companyId]);
  return new Set(rows.map((r) => String(r.task_id)));
}

/** Put a queued note into a run. Compare-and-swap: false if it is no longer queued. */
export async function startQueuedNote(db: Db, id: string, handoverKey: string): Promise<boolean> {
  const { rowCount } = await db.execute(`UPDATE ${table(db)} SET status = 'handed_over', handover_key = $1, updated_at = now() WHERE id = $2 AND status = 'queued'`, [
    handoverKey,
    id,
  ]);
  return rowCount === 1;
}

/** Take back a note that has not started (a queued one, or a draft). */
export async function withdrawNote(db: Db, id: string, from: "queued" | "draft"): Promise<boolean> {
  const { rowCount } = await db.execute(`UPDATE ${table(db)} SET status = 'withdrawn', updated_at = now() WHERE id = $1 AND status = $2`, [id, from]);
  return rowCount === 1;
}
