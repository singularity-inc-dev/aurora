import { execFile, spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { runChecksGate, localRunner, type GateResult } from "./checks.js";
import type { ChecksSettings } from "./config.js";
import { MAX_TASKS, MIN_TASKS, type Arm, type RunRecord, type Skip, type TaskLabel, type Verdict } from "./replayeval.js";
import type { ReplayTask } from "./replaysave.js";
import { redact } from "./secretscan.js";

/** The file `vt-replay save` writes and `vt-replay run` reads. */
export const TASKS_FORMAT = "vt-replay-tasks/1";

export type GateSettings = Pick<ChecksSettings, "testCommand" | "lintCommand" | "maxDiffLines" | "timeoutSeconds">;

export interface TasksFile {
  tasks: ReplayTask[];
  checks: GateSettings | null;
}

const SHA = /^[0-9a-f]{40}([0-9a-f]{24})?$/;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const optString = (v: unknown): string | null => (typeof v === "string" ? v : null);

/** Read and check the saved-tasks file. Returns plain-English problems instead of throwing on bad content. */
export function parseTasksFile(text: string): { ok: true; file: TasksFile } | { ok: false; errors: string[] } {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, errors: ["the tasks file is not valid JSON"] };
  }
  if (!isRecord(raw) || raw.format !== TASKS_FORMAT) return { ok: false, errors: [`the tasks file is not in the "${TASKS_FORMAT}" format (was it written by vt-replay save?)`] };
  if (!Array.isArray(raw.tasks)) return { ok: false, errors: ["the tasks file has no list of tasks"] };
  const errors: string[] = [];
  const tasks: ReplayTask[] = [];
  raw.tasks.forEach((t, i) => {
    if (!isRecord(t) || typeof t.taskId !== "string" || typeof t.title !== "string" || typeof t.baseSha !== "string") {
      errors.push(`task ${i + 1}: missing its id, title or starting commit`);
      return;
    }
    tasks.push({
      taskId: t.taskId,
      identifier: optString(t.identifier),
      owner: optString(t.owner) ?? "",
      taskKind: optString(t.taskKind) ?? "task",
      title: t.title,
      description: optString(t.description) ?? "",
      inputsRedacted: t.inputsRedacted === true,
      descriptionTruncated: t.descriptionTruncated === true,
      baseRef: optString(t.baseRef),
      baseSha: t.baseSha,
      headSha: optString(t.headSha) ?? "",
      checksResult: optString(t.checksResult),
      outcome: optString(t.outcome),
      rejectReason: optString(t.rejectReason),
      startedAt: optString(t.startedAt),
      finishedAt: optString(t.finishedAt),
      durationSeconds: typeof t.durationSeconds === "number" ? t.durationSeconds : null,
    });
  });
  if (errors.length) return { ok: false, errors };
  let checks: GateSettings | null = null;
  if (isRecord(raw.checks)) {
    const c = raw.checks;
    checks = {
      testCommand: optString(c.testCommand) || null,
      lintCommand: optString(c.lintCommand) || null,
      maxDiffLines: typeof c.maxDiffLines === "number" && c.maxDiffLines > 0 ? c.maxDiffLines : 400,
      timeoutSeconds: typeof c.timeoutSeconds === "number" && c.timeoutSeconds > 0 ? c.timeoutSeconds : 300,
    };
  }
  return { ok: true, file: { tasks, checks } };
}

export class ReplayRefused extends Error {}

/** The agent and the checks run code. Do not do that as root. */
export function assertNotRoot(uid: number | undefined, allowRoot: boolean): void {
  if (uid === 0 && !allowRoot) {
    throw new ReplayRefused("refusing to run as root: the agent and the tests run code written by a model. Run as an ordinary user, or pass --allow-root in a throwaway machine.");
  }
}

function git(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("git", args, { cwd, encoding: "utf8", maxBuffer: 16 * 1024 * 1024, env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", LANG: "C.UTF-8", GIT_TERMINAL_PROMPT: "0" } }, (err, stdout, stderr) => {
      if (err) reject(new Error((stderr || err.message).toString().trim().split("\n")[0]));
      else resolve(stdout);
    });
  });
}

async function commitExists(repo: string, sha: string): Promise<boolean> {
  try {
    await git(repo, ["cat-file", "-e", `${sha}^{commit}`]);
    return true;
  } catch {
    return false;
  }
}

export interface ReplayOptions {
  /** A clone of the project (any folder with the tasks' starting commits in it). Never modified. */
  repo: string;
  baselinePrompt: string;
  candidatePrompt: string;
  /** Run in the task's folder with VT_REPLAY_PROMPT_FILE and VT_REPLAY_TASK_FILE set. */
  agentCommand: string;
  agentTimeoutSeconds: number;
  repeats: number;
  limit: number;
  checks: GateSettings;
  /** Names of environment variables to hand to the agent (values are never printed). */
  passEnv: string[];
  /** Commit whatever the agent left uncommitted. Off by default: the product only checks commits. */
  commitLeftovers: boolean;
  allowFewer: boolean;
  keep: boolean;
  /** Where throwaway clones go. Default: the system temp folder. */
  workDir?: string;
  log?: (line: string) => void;
}

export interface ReplayOutcome {
  runs: RunRecord[];
  skipped: Skip[];
  labels: TaskLabel[];
}

const label = (t: ReplayTask): TaskLabel => ({ taskId: t.taskId, identifier: t.identifier, title: t.title, originalChecks: t.checksResult, originalOutcome: t.outcome });

/** Which saved tasks can be replayed here, and why not for the rest. */
export async function selectTasks(tasks: ReplayTask[], repo: string): Promise<{ usable: ReplayTask[]; skipped: Skip[] }> {
  const usable: ReplayTask[] = [];
  const skipped: Skip[] = [];
  const seen = new Set<string>();
  for (const t of tasks) {
    const skip = (reason: string) => skipped.push({ taskId: t.taskId, identifier: t.identifier, reason });
    if (seen.has(t.taskId)) {
      skip("listed twice in the tasks file");
      continue;
    }
    seen.add(t.taskId);
    if (!SHA.test(t.baseSha)) skip("its starting commit is not a full commit id");
    else if (t.descriptionTruncated) skip("the ticket text was cut short when it was saved, so the inputs are incomplete");
    else if (!(await commitExists(repo, t.baseSha))) skip("its starting commit is not in this repository (fetch the project first)");
    else usable.push(t);
  }
  return { usable, skipped };
}

function agentEnvironment(passEnv: string[], extra: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", LANG: "C.UTF-8", TERM: "dumb", CI: "1" };
  for (const name of passEnv) {
    const v = process.env[name];
    if (ENV_NAME.test(name) && v !== undefined) env[name] = v;
  }
  return { ...env, ...extra };
}

interface AgentOutcome {
  exitCode: number | null;
  timedOut: boolean;
  couldNotStart: boolean;
  /** Last line the agent printed, redacted. Only used to explain a failure. */
  lastLine: string;
  seconds: number;
}

function runAgent(command: string, cwd: string, env: Record<string, string>, timeoutSeconds: number): Promise<AgentOutcome> {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(command, { cwd, shell: true, detached: true, env, stdio: ["ignore", "pipe", "pipe"] });
    let tail = "";
    const collect = (chunk: Buffer) => {
      tail = (tail + chunk.toString("utf8")).slice(-2000);
    };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        process.kill(-child.pid!, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    }, timeoutSeconds * 1000);
    const finish = (exitCode: number | null, couldNotStart: boolean) => {
      clearTimeout(timer);
      const last = redact(tail).split("\n").map((l) => l.trim()).filter(Boolean).pop() ?? "";
      resolve({ exitCode, timedOut, couldNotStart, lastLine: last.slice(0, 120), seconds: (Date.now() - started) / 1000 });
    };
    child.on("close", (code) => finish(code, false));
    child.on("error", () => finish(null, true));
  });
}

const VERDICT: Record<GateResult, Verdict> = { passed: "passed", failed: "failed", "not-tested": "not-tested", "no-changes": "no-changes" };

async function runOne(task: ReplayTask, arm: Arm, repeat: number, promptFile: string, o: ReplayOptions): Promise<RunRecord> {
  const base: Pick<RunRecord, "taskId" | "arm" | "repeat"> = { taskId: task.taskId, arm, repeat };
  const root = await mkdtemp(path.join(o.workDir ?? tmpdir(), "vt-replay-"));
  const dir = path.join(root, "work");
  try {
    // A private copy at the starting commit. It has no remote, so the agent cannot push anywhere.
    await git(root, ["clone", "--quiet", "--no-checkout", "--local", o.repo, dir]);
    await git(dir, ["remote", "remove", "origin"]);
    await git(dir, ["checkout", "--quiet", "--detach", task.baseSha]);
    await git(dir, ["checkout", "--quiet", "-b", `replay/${arm}`]);
    for (const [k, v] of [["user.name", "Replay"], ["user.email", "replay@example.invalid"], ["commit.gpgsign", "false"]] as const) await git(dir, ["config", k, v]);

    // The task as the agent sees it, kept outside the working folder so it can never be committed.
    const taskFile = path.join(root, "task.md");
    await writeFile(taskFile, `# ${task.title}\n\n${task.description}\n`, { mode: 0o600 });

    const agent = await runAgent(
      o.agentCommand,
      dir,
      agentEnvironment(o.passEnv, { VT_REPLAY_PROMPT_FILE: path.resolve(promptFile), VT_REPLAY_TASK_FILE: taskFile, VT_REPLAY_TASK_ID: task.taskId, VT_REPLAY_ARM: arm }),
      o.agentTimeoutSeconds,
    );
    if (agent.couldNotStart) return { ...base, verdict: "agent-error", agentSeconds: null, checkSeconds: null, detail: "the agent command could not be started", failedChecks: [] };
    if (agent.timedOut) return { ...base, verdict: "agent-error", agentSeconds: agent.seconds, checkSeconds: null, detail: `the agent did not finish within ${o.agentTimeoutSeconds}s and was stopped`, failedChecks: [] };

    if (o.commitLeftovers) {
      await git(dir, ["add", "-A"]);
      if ((await git(dir, ["status", "--porcelain"])).trim()) await git(dir, ["commit", "--quiet", "-m", "replay: leftovers"]);
    }
    const gateStarted = Date.now();
    const report = await runChecksGate(dir, task.baseSha, { ...o.checks, sandbox: null }, localRunner(dir));
    const checkSeconds = (Date.now() - gateStarted) / 1000;
    const failed = report.results.filter((r) => r.status === "failed");
    const exitNote = agent.exitCode === 0 ? "" : ` The agent exited with code ${agent.exitCode}${agent.lastLine ? ` (last line: ${agent.lastLine})` : ""}.`;
    const detail =
      report.result === "passed"
        ? "every check passed"
        : report.result === "not-tested"
          ? "no test command is set up, so nothing was tested"
          : report.result === "no-changes"
            ? "nothing was committed beyond the starting commit"
            : failed.map((r) => `${r.name}: ${r.summary}`).join("; ");
    return { ...base, verdict: VERDICT[report.result], agentSeconds: agent.seconds, checkSeconds, detail: redact(detail + (report.result === "passed" ? "" : exitNote)).slice(0, 300), failedChecks: failed.map((r) => r.name) };
  } catch (err) {
    return { ...base, verdict: "agent-error", agentSeconds: null, checkSeconds: null, detail: `could not prepare the task folder: ${redact(err instanceof Error ? err.message : "unknown error").slice(0, 160)}`, failedChecks: [] };
  } finally {
    if (o.keep) o.log?.(`kept ${root}`);
    else await rm(root, { recursive: true, force: true });
  }
}

/** Run every selected task with both prompts, alternating which prompt goes first. */
export async function runReplay(allTasks: ReplayTask[], o: ReplayOptions): Promise<ReplayOutcome> {
  const limit = Math.max(1, Math.min(MAX_TASKS, Math.floor(o.limit)));
  const repoStat = await stat(o.repo).catch(() => null);
  if (!repoStat?.isDirectory()) throw new ReplayRefused(`the repository folder does not exist: ${o.repo}`);
  if (o.workDir) await mkdir(o.workDir, { recursive: true });
  for (const name of o.passEnv) if (!ENV_NAME.test(name)) throw new ReplayRefused(`"${name}" is not a valid environment variable name`);

  const { usable, skipped } = await selectTasks(allTasks, o.repo);
  const chosen = usable.slice(0, limit);
  skipped.push(...usable.slice(limit).map((t) => ({ taskId: t.taskId, identifier: t.identifier, reason: `over the limit of ${limit} tasks` })));
  if (chosen.length === 0) throw new ReplayRefused("none of the saved tasks can be replayed here (see the reasons below)");
  if (chosen.length < MIN_TASKS && !o.allowFewer) {
    throw new ReplayRefused(`only ${chosen.length} task(s) can be replayed; a comparison needs ${MIN_TASKS} to ${MAX_TASKS}. Save more tasks, or pass --allow-fewer to run anyway.`);
  }

  const runs: RunRecord[] = [];
  const prompts: Record<Arm, string> = { baseline: o.baselinePrompt, candidate: o.candidatePrompt };
  for (const [i, task] of chosen.entries()) {
    const order: Arm[] = i % 2 === 0 ? ["baseline", "candidate"] : ["candidate", "baseline"];
    for (let repeat = 1; repeat <= o.repeats; repeat += 1) {
      for (const arm of order) {
        const r = await runOne(task, arm, repeat, prompts[arm], o);
        runs.push(r);
        o.log?.(`[${i + 1}/${chosen.length}] ${task.identifier ?? task.taskId} ${arm}${o.repeats > 1 ? ` #${repeat}` : ""}: ${r.verdict}${r.agentSeconds !== null ? ` (${Math.round(r.agentSeconds)}s)` : ""}`);
      }
    }
  }
  return { runs, skipped, labels: chosen.map(label) };
}
