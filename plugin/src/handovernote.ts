import type { PluginDatabaseClient } from "@paperclipai/plugin-sdk";
import { MAX_CLAIMS_PER_TASK, normalizeClaim } from "./claims.js";
import { redact } from "./secretscan.js";

/**
 * The handover note: what the owner writes on each task they hand over. It is
 * locked when the owner hands the task over (the agent cannot change it), and at
 * handback the plugin itself says whether "done when" was met. The agent never
 * certifies its own work: a "met" only ever comes from the plugin running the
 * operator's test command and finding the owner's named tests passing in its output.
 */
export interface HandoverNote {
  /** The owner's own words: how to know the task is done. */
  doneWhen: string;
  /** Test names that prove it (the machine check). Empty: the owner verifies by hand. */
  tests: string[];
  /** Files and folders the task may change (its claims, for the pre-handover check). */
  claims: string[];
}

export const MAX_DONE_WHEN = 500;
export const MAX_TESTS = 5;
export const MAX_TEST_NAME = 200;
/** Matched output lines kept per test name, as evidence. */
const MAX_EVIDENCE_LINES = 2;
const MAX_EVIDENCE_CHARS = 200;

/** Who wrote the note: the owner on Hand over now, or the agent's proposal the owner approved on the plan. */
export type NoteSource = "owner" | "agent-proposal";

const splitList = (raw: unknown): string[] => {
  if (Array.isArray(raw)) return raw.map((x) => (typeof x === "string" ? x : "")).flatMap((x) => x.split(/[\n,]/));
  if (typeof raw === "string") return raw.split(/[\n,]/);
  return [];
};

/**
 * Check a note. `doneWhen` and the files are required; tests are optional.
 * Files may be one string ("src/ui/, README.md", or one per line) or a list.
 * Test names are one per line (a name may contain commas) or a list.
 */
export function parseNote(raw: { doneWhen?: unknown; files?: unknown; tests?: unknown }, required = true): HandoverNote | string {
  const doneWhen = typeof raw.doneWhen === "string" ? raw.doneWhen.trim().replace(/\s+/g, " ") : "";
  if (required && !doneWhen) return 'write what "done" means (Done when)';
  if (doneWhen.length > MAX_DONE_WHEN) return `"Done when" is too long (at most ${MAX_DONE_WHEN} characters)`;

  const files = splitList(raw.files).map((f) => f.trim()).filter(Boolean);
  if (required && files.length === 0) return 'list the files or folders it may change (for example "src/ui/, README.md")';
  if (files.length > MAX_CLAIMS_PER_TASK) return `at most ${MAX_CLAIMS_PER_TASK} files or folders`;
  const claims = new Set<string>();
  for (const f of files) {
    const c = normalizeClaim(f);
    if (!c) return `"${f.slice(0, 80)}" must be a path inside the repository ("*", "?" and "**" allowed)`;
    claims.add(c);
  }

  const testsRaw = Array.isArray(raw.tests) ? raw.tests : typeof raw.tests === "string" ? raw.tests.split("\n") : [];
  const tests = [...new Set(testsRaw.map((t) => (typeof t === "string" ? t.trim() : "")).filter(Boolean))];
  if (tests.length > MAX_TESTS) return `at most ${MAX_TESTS} test names`;
  if (tests.some((t) => t.length > MAX_TEST_NAME)) return `a test name is too long (at most ${MAX_TEST_NAME} characters)`;
  if (tests.some((t) => t.length < 3)) return "a test name is too short (at least 3 characters)";
  return { doneWhen, tests, claims: [...claims] };
}

/** The comment the agent reads on its ticket. The locked copy is the plugin's own. */
export function noteComment(owner: string, note: Pick<HandoverNote, "doneWhen" | "tests" | "claims">, source: NoteSource): string {
  const who = source === "owner" ? `${owner} handed this task over with this note` : `${owner} approved this note on the plan`;
  return [
    `**Handover note** (${who}; it is locked, so edits to this ticket do not change it):`,
    "",
    `- **Done when:** ${note.doneWhen || "(not written)"}`,
    `- **Files it may change:** ${note.claims.map((c) => `\`${c}\``).join(", ")}`,
    note.tests.length
      ? `- **Tests that prove it:** ${note.tests.map((t) => `"${t}"`).join(", ")}. Aurora runs the test command itself and looks for these names passing; make sure the test command lists each test by name.`
      : "- **Tests that prove it:** none named, so the owner checks it by hand.",
    "",
    "Do only this task. Run the checks gate (`run_checks`) when you are done.",
  ].join("\n");
}

export type DoneWhenVerdict = "met" | "not-met" | "owner-to-verify";

export interface DoneWhenResult {
  result: DoneWhenVerdict;
  evidence: string[];
}

/** What the plugin saw when it ran the tests command itself. */
export interface TestRun {
  status: "passed" | "failed" | "skipped";
  summary: string;
  /** Output lines that mention each watched test name. */
  found: Record<string, string[]>;
}

const NOT_A_PASS = /\b(skip|skipped|todo|pending|xfail|xfailed|fail|failed|failure|error)\b|[✗×✘↓]/i;

/**
 * The plugin's verdict on "done when". Machine check: every named test appears in
 * the output of a passing test run, on a line that does not say skipped or failed.
 * No named tests, or no test command: the owner verifies by hand.
 */
export function judgeDoneWhen(note: Pick<HandoverNote, "doneWhen" | "tests"> | null, tests: TestRun | null): DoneWhenResult {
  if (!note || !note.doneWhen) return { result: "owner-to-verify", evidence: ['no "done when" was written for this task'] };
  if (note.tests.length === 0) return { result: "owner-to-verify", evidence: ["no test was named, so there is no machine check"] };
  if (!tests || tests.status === "skipped") return { result: "owner-to-verify", evidence: ["no test command is set up, so the named tests could not be run"] };
  const evidence = [`test command: ${tests.status === "passed" ? "passed" : "FAILED"} (${tests.summary})`];
  let met = tests.status === "passed";
  for (const name of note.tests) {
    const lines = tests.found[name] ?? [];
    // The words around the name decide (a name like "shows an error" must not count as a failure).
    const without = (l: string) => {
      const at = l.toLowerCase().indexOf(name.toLowerCase());
      return at < 0 ? l : l.slice(0, at) + l.slice(at + name.length);
    };
    const passing = lines.filter((l) => !NOT_A_PASS.test(without(l)));
    if (lines.length === 0) {
      met = false;
      evidence.push(`"${name}": not in the test output`);
    } else if (passing.length === 0) {
      met = false;
      evidence.push(`"${name}": skipped or failed: ${lines[0]}`);
    } else {
      evidence.push(`"${name}": ${passing[0]}`);
    }
  }
  return { result: met ? "met" : "not-met", evidence };
}

const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;

/**
 * Watches command output, line by line, for the given test names (case-insensitive),
 * across chunk boundaries. Keeps a few short, redacted lines per name.
 */
export class LineWatcher {
  private partial = "";
  readonly found: Record<string, string[]> = {};
  private readonly lower: Array<[string, string]>;

  constructor(names: readonly string[]) {
    this.lower = names.map((n) => [n, n.toLowerCase()]);
    for (const n of names) this.found[n] = [];
  }

  feed(chunk: string): void {
    if (this.lower.length === 0) return;
    const text = this.partial + chunk;
    const lines = text.split(/\r?\n|\r/);
    this.partial = (lines.pop() ?? "").slice(-4096);
    for (const line of lines) this.line(line);
  }

  end(): Record<string, string[]> {
    if (this.partial) this.line(this.partial);
    this.partial = "";
    return this.found;
  }

  private line(raw: string): void {
    const line = raw.replace(ANSI, "").trim();
    if (!line) return;
    const l = line.toLowerCase();
    for (const [name, lower] of this.lower) {
      const kept = this.found[name]!;
      if (kept.length < MAX_EVIDENCE_LINES && l.includes(lower)) kept.push(redact(line).slice(0, MAX_EVIDENCE_CHARS));
    }
  }
}

type Db = Pick<PluginDatabaseClient, "namespace" | "execute" | "query">;
const events = (db: Db) => `"${db.namespace}".task_events`;

/** Lock the owner's note on a task's event-log row (a new hand-over by the owner replaces it). */
export async function lockNote(db: Db, taskId: string, title: string, note: Pick<HandoverNote, "doneWhen" | "tests">, source: NoteSource, at: Date): Promise<void> {
  await db.execute(
    `UPDATE ${events(db)} SET note_title = $1, done_when = $2, done_when_tests = $3, note_source = $4, note_locked_at = $5, done_when_result = NULL, done_when_head = NULL, updated_at = now() WHERE task_id = $6`,
    [title, note.doneWhen || null, JSON.stringify(note.tests), source, at.toISOString(), taskId],
  );
}

export interface LockedNote {
  title: string | null;
  doneWhen: string | null;
  tests: string[];
  source: NoteSource | null;
  result: DoneWhenVerdict | null;
  evidence: string[];
  head: string | null;
}

const list = (v: unknown): string[] => {
  try {
    const parsed = JSON.parse(String(v ?? "[]"));
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
};

/** The locked note and its verdict from an event-log row (null: the task has no note). */
export function noteOf(row: Record<string, unknown> | null): LockedNote | null {
  if (!row || !row.note_locked_at) return null;
  const result = row.done_when_result;
  return {
    title: (row.note_title as string | null) ?? null,
    doneWhen: (row.done_when as string | null) ?? null,
    tests: list(row.done_when_tests),
    source: row.note_source === "owner" || row.note_source === "agent-proposal" ? row.note_source : null,
    result: result === "met" || result === "not-met" || result === "owner-to-verify" ? result : null,
    evidence: list(row.done_when_evidence),
    head: (row.done_when_head as string | null) ?? null,
  };
}

/** Store the plugin's verdict with the commit it was reached on. */
export async function recordDoneWhen(db: Db, taskId: string, r: DoneWhenResult, head: string | null): Promise<void> {
  await db.execute(`UPDATE ${events(db)} SET done_when_result = $1, done_when_evidence = $2, done_when_head = $3, updated_at = now() WHERE task_id = $4`, [
    r.result,
    JSON.stringify(r.evidence),
    head,
    taskId,
  ]);
}

/** What the handback email says about "done when" for a task at a given branch head. */
export function doneWhenLine(note: LockedNote | null, branchHead: string | null): { doneWhen: string | null; verdict: DoneWhenVerdict; evidence: string[] } {
  if (!note) return { doneWhen: null, verdict: "owner-to-verify", evidence: ["this task has no handover note"] };
  if (!note.doneWhen) return { doneWhen: null, verdict: "owner-to-verify", evidence: ['no "done when" was written for this task'] };
  if (!note.result) return { doneWhen: note.doneWhen, verdict: "owner-to-verify", evidence: ["the checks gate was not run, so nothing was checked"] };
  if (!branchHead || note.head !== branchHead) {
    return { doneWhen: note.doneWhen, verdict: "owner-to-verify", evidence: ["the check did not run on the latest commit"] };
  }
  return { doneWhen: note.doneWhen, verdict: note.result, evidence: note.evidence };
}
