/**
 * Compare two prompts on the same saved tasks (evals). Pure: no files, no git.
 *
 * The result is decided by the checks gate only (tests, lint, diff size, secret
 * scan). There is no AI judge: a prompt that makes the tests pass beats a prompt
 * that reads well. Time is reported next to it, not mixed into it.
 */

export type Arm = "baseline" | "candidate";

/**
 * What one run came to. The first four are the checks gate's own words.
 * "agent-error": the agent could not start or ran out of time, so nothing was checked.
 * "skipped": the task could not be replayed at all (see Skip).
 */
export type Verdict = "passed" | "not-tested" | "failed" | "no-changes" | "agent-error";

export interface RunRecord {
  taskId: string;
  arm: Arm;
  /** 1-based; more than one only with --repeats. */
  repeat: number;
  verdict: Verdict;
  /** Wall-clock seconds the agent ran. */
  agentSeconds: number | null;
  /** Wall-clock seconds the checks gate ran. */
  checkSeconds: number | null;
  /** One plain sentence: why this verdict. Never ticket text or agent output. */
  detail: string;
  /** Names of the checks that failed (diff-size, secret-scan, tests, lint). */
  failedChecks: string[];
}

export interface Skip {
  taskId: string;
  /** The ticket number to show people (falls back to the task id). */
  identifier?: string | null;
  reason: string;
}

/** The task as the report needs it. */
export interface TaskLabel {
  taskId: string;
  identifier: string | null;
  title: string;
  /** What happened to it the first time round: its checks result and outcome. */
  originalChecks: string | null;
  originalOutcome: string | null;
}

export interface ArmSummary {
  runs: number;
  passed: number;
  notTested: number;
  failed: number;
  noChanges: number;
  agentError: number;
  /** passed / runs, or null when there were no runs. */
  passRate: number | null;
  medianAgentSeconds: number | null;
  totalSeconds: number;
}

export interface Comparison {
  tasks: number;
  baseline: ArmSummary;
  candidate: ArmSummary;
  /** Tasks the candidate passed and the baseline did not. */
  candidateOnly: string[];
  /** Tasks the baseline passed and the candidate did not. */
  baselineOnly: string[];
  bothPassed: number;
  neitherPassed: number;
  /** Two-sided exact sign test on candidateOnly vs baselineOnly; null when no task differs. */
  signTestP: number | null;
  /** Candidate median agent time as a fraction of baseline's (1 = same), or null. */
  timeRatio: number | null;
  conclusion: string;
  /** Anything the reader must know before trusting the numbers. */
  warnings: string[];
}

/** The fewest tasks a comparison is worth reading with (the brief: 10 to 20). */
export const MIN_TASKS = 10;
export const MAX_TASKS = 20;
const ALPHA = 0.05;

const median = (xs: number[]): number | null => {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
};

export function summarize(runs: RunRecord[]): ArmSummary {
  const count = (v: Verdict) => runs.filter((r) => r.verdict === v).length;
  const agent = runs.map((r) => r.agentSeconds).filter((x): x is number => x !== null);
  return {
    runs: runs.length,
    passed: count("passed"),
    notTested: count("not-tested"),
    failed: count("failed"),
    noChanges: count("no-changes"),
    agentError: count("agent-error"),
    passRate: runs.length ? count("passed") / runs.length : null,
    medianAgentSeconds: median(agent),
    totalSeconds: runs.reduce((sum, r) => sum + (r.agentSeconds ?? 0) + (r.checkSeconds ?? 0), 0),
  };
}

/** P(X = k) for X ~ Binomial(n, 1/2), by log-gamma-free iteration (n is small here). */
function binomialHalf(n: number, k: number): number {
  let logp = -n * Math.LN2;
  for (let i = 1; i <= k; i += 1) logp += Math.log((n - k + i) / i);
  return Math.exp(logp);
}

/** Two-sided exact sign test: how likely is a split at least this uneven if the prompts were equal? */
export function signTest(a: number, b: number): number | null {
  const n = a + b;
  if (n === 0) return null;
  const lo = Math.min(a, b);
  let tail = 0;
  for (let k = 0; k <= lo; k += 1) tail += binomialHalf(n, k);
  return Math.min(1, 2 * tail);
}

/** A task counts as passed by an arm when more than half of that arm's runs passed. */
function taskPassed(runs: RunRecord[]): boolean {
  return runs.length > 0 && runs.filter((r) => r.verdict === "passed").length * 2 > runs.length;
}

const p3 = (p: number) => (p < 0.001 ? "< 0.001" : p.toFixed(3));

export function compare(runs: RunRecord[]): Comparison {
  const of = (arm: Arm) => runs.filter((r) => r.arm === arm);
  const ids = [...new Set(runs.map((r) => r.taskId))];
  const candidateOnly: string[] = [];
  const baselineOnly: string[] = [];
  let bothPassed = 0;
  let neitherPassed = 0;
  for (const id of ids) {
    const b = taskPassed(of("baseline").filter((r) => r.taskId === id));
    const c = taskPassed(of("candidate").filter((r) => r.taskId === id));
    if (b && c) bothPassed += 1;
    else if (!b && !c) neitherPassed += 1;
    else if (c) candidateOnly.push(id);
    else baselineOnly.push(id);
  }
  const baseline = summarize(of("baseline"));
  const candidate = summarize(of("candidate"));
  const p = signTest(candidateOnly.length, baselineOnly.length);
  const timeRatio =
    baseline.medianAgentSeconds && candidate.medianAgentSeconds !== null ? candidate.medianAgentSeconds / baseline.medianAgentSeconds : null;

  const warnings: string[] = [];
  if (ids.length < MIN_TASKS) warnings.push(`Only ${ids.length} task${ids.length === 1 ? "" : "s"} were replayed (${MIN_TASKS} to ${MAX_TASKS} is the point of this tool). Read the numbers as anecdotes.`);
  const repeats = Math.max(0, ...runs.map((r) => r.repeat));
  if (repeats <= 1) warnings.push("Each task ran once per prompt. An agent can pass on one try and fail on the next, so a single run is noisy. Use --repeats 3 for a steadier answer.");
  if (baseline.agentError + candidate.agentError > 0) warnings.push(`${baseline.agentError + candidate.agentError} run(s) ended with an agent error or time-out, so nothing was checked for them. They count as not passed.`);
  if (baseline.notTested + candidate.notTested > 0) warnings.push("Some runs are NOT TESTED: no test command is set up, so the gate could not say they work. They never count as passed.");

  let conclusion: string;
  const k = candidateOnly.length;
  const m = baselineOnly.length;
  if (p === null) {
    conclusion = "No task changed between passing and not passing. On these tasks the two prompts did the same.";
  } else if (p < ALPHA) {
    conclusion = `${k > m ? "The candidate is better" : "The candidate is worse"}: it passed ${k} task${k === 1 ? "" : "s"} the baseline did not, and the baseline passed ${m} the candidate did not (sign test p = ${p3(p)}).`;
  } else {
    conclusion =
      `Cannot tell. The candidate passed ${k} task${k === 1 ? "" : "s"} the baseline did not, and the baseline passed ${m} the candidate did not (sign test p = ${p3(p)}). ` +
      "A gap this size could be luck. To show a real difference at the 5% level, one prompt needs to win at least 6 tasks the other fails, with none the other way.";
  }
  return { tasks: ids.length, baseline, candidate, candidateOnly, baselineOnly, bothPassed, neitherPassed, signTestP: p, timeRatio, conclusion, warnings };
}

export function formatSeconds(s: number | null): string {
  if (s === null) return "n/a";
  const total = Math.round(s);
  if (total < 90) return `${total}s`;
  const m = Math.floor(total / 60);
  return m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m}m ${total - m * 60}s`;
}

const cell = (text: string, max = 70): string => {
  const flat = text.replace(/\s+/g, " ").replace(/\|/g, "\\|").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};

const WORD: Record<Verdict, string> = { passed: "passed", "not-tested": "NOT TESTED", failed: "FAILED", "no-changes": "nothing committed", "agent-error": "agent error" };

function armCell(runs: RunRecord[]): string {
  if (runs.length === 0) return "–";
  if (runs.length === 1) return WORD[runs[0]!.verdict];
  const passed = runs.filter((r) => r.verdict === "passed").length;
  return `${passed}/${runs.length} passed`;
}

export interface ReportInput {
  runs: RunRecord[];
  labels: TaskLabel[];
  skipped: Skip[];
  baselineName: string;
  candidateName: string;
  gate: string;
  generatedAt: Date;
}

/** The report a person reads. Markdown. Contains ticket titles (cut short) but never ticket bodies or agent output. */
export function renderReport(input: ReportInput): string {
  const c = compare(input.runs);
  const row = (name: string, f: (s: ArmSummary) => string) => `| ${name} | ${f(c.baseline)} | ${f(c.candidate)} |`;
  const lines = [
    "# Replay: baseline against candidate",
    "",
    `- Baseline prompt: \`${input.baselineName}\``,
    `- Candidate prompt: \`${input.candidateName}\``,
    `- Tasks replayed: ${c.tasks}${input.skipped.length ? ` (${input.skipped.length} could not be replayed, listed at the end)` : ""}`,
    `- Checks gate: ${input.gate}`,
    `- Generated: ${input.generatedAt.toISOString()}`,
    "- Decided by tests only. No AI judge.",
    "",
    "## Result",
    "",
    "| | Baseline | Candidate |",
    "|---|---|---|",
    row("Runs", (s) => String(s.runs)),
    row("Passed", (s) => String(s.passed)),
    row("Not tested", (s) => String(s.notTested)),
    row("Failed", (s) => String(s.failed)),
    row("Nothing committed", (s) => String(s.noChanges)),
    row("Agent error or time-out", (s) => String(s.agentError)),
    row("Pass rate", (s) => (s.passRate === null ? "n/a" : `${Math.round(s.passRate * 100)}%`)),
    row("Median agent time", (s) => formatSeconds(s.medianAgentSeconds)),
    row("Total time (agent + checks)", (s) => formatSeconds(s.totalSeconds)),
    "",
    `**${c.conclusion}**`,
    "",
    `Only the baseline passed: ${c.baselineOnly.length}. Only the candidate passed: ${c.candidateOnly.length}. Both passed: ${c.bothPassed}. Neither passed: ${c.neitherPassed}.`,
  ];
  if (c.timeRatio !== null) {
    const pct = Math.round(Math.abs(c.timeRatio - 1) * 100);
    lines.push(`Median agent time: the candidate took ${pct === 0 ? "about the same time" : c.timeRatio < 1 ? `${pct}% less time` : `${pct}% more time`} than the baseline. Time is not part of the verdict.`);
  }
  if (c.warnings.length) lines.push("", "## Read this first", "", ...c.warnings.map((w) => `- ${w}`));

  lines.push("", "## Task by task", "", "| Task | First time round | Baseline | Candidate |", "|---|---|---|---|");
  for (const l of input.labels) {
    const forTask = (arm: Arm) => input.runs.filter((r) => r.taskId === l.taskId && r.arm === arm);
    const first = [l.originalOutcome ?? "undecided", l.originalChecks ? `checks ${l.originalChecks}` : null].filter(Boolean).join(", ");
    lines.push(`| ${cell(`${l.identifier ? `${l.identifier} ` : ""}${l.title}`)} | ${cell(first)} | ${armCell(forTask("baseline"))} | ${armCell(forTask("candidate"))} |`);
  }
  const details = input.runs.filter((r) => r.verdict === "failed" || r.verdict === "agent-error");
  if (details.length) {
    lines.push("", "## Why runs did not pass", "", "| Task | Prompt | Run | Why |", "|---|---|---|---|");
    for (const r of details) {
      const l = input.labels.find((x) => x.taskId === r.taskId);
      lines.push(`| ${cell(l?.identifier ?? r.taskId, 30)} | ${r.arm} | ${r.repeat} | ${cell(r.detail, 90)} |`);
    }
  }
  if (input.skipped.length) {
    lines.push("", "## Could not be replayed", "", ...input.skipped.map((s) => `- ${cell(s.identifier ?? s.taskId, 40)}: ${cell(s.reason, 120)}`));
  }
  return lines.join("\n") + "\n";
}
