import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ChecksSettings } from "./config.js";
import { addedLines, diffStats, headSha, mergeBase } from "./git.js";
import { redact, scanAddedLines, scanFileNames, type SecretFinding } from "./secretscan.js";

export type CheckStatus = "passed" | "failed" | "skipped";

/**
 * The gate's verdict. "not-tested": nothing failed, but no test command is set
 * up, so nothing was tested. It is never reported as "passed".
 */
export type GateResult = "passed" | "failed" | "not-tested";

export interface CheckResult {
  name: "diff-size" | "secret-scan" | "tests" | "lint";
  status: CheckStatus;
  summary: string;
  /** Tail of command output, already redacted. */
  output?: string;
}

export interface ChecksReport {
  /** True only when every check passed and the tests really ran. */
  passed: boolean;
  result: GateResult;
  /** The commit that was checked: committed files only, never the working folder. */
  headSha: string | null;
  baseRef: string;
  results: CheckResult[];
}

const OUTPUT_TAIL_CHARS = 4000;

export interface CommandOutcome {
  exitCode: number | null;
  timedOut: boolean;
  output: string;
}

/**
 * Runs one operator-configured command on the committed files of `commit`
 * (locally, or in the checks sandbox: checksandbox.ts). Uncommitted or untracked
 * files in the worktree are never seen by the command.
 */
export type CommandRunner = (command: string, timeoutSeconds: number, commit: string) => Promise<CommandOutcome>;

/**
 * Test beds only (isolation off): run in a fresh folder holding exactly the
 * commit's files (`git archive`), deleted afterwards.
 */
export const localRunner = (cwd: string): CommandRunner => async (command, timeoutSeconds, commit) => {
  const dir = await mkdtemp(path.join(tmpdir(), "vt-checks-"));
  try {
    if (!(await exportCommit(cwd, commit, dir))) return { exitCode: null, timedOut: false, output: "could not copy the commit's files" };
    return await runCommand(command, dir, timeoutSeconds);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
};

/** Unpack the files of `commit` (committed only, no .git) into `dir`. */
export function exportCommit(cwd: string, commit: string, dir: string): Promise<boolean> {
  if (!/^[0-9a-f]{40}([0-9a-f]{24})?$/.test(commit)) return Promise.resolve(false);
  return new Promise((resolve) => {
    const env = { PATH: process.env.PATH ?? "", LANG: "C.UTF-8" };
    const archive = spawn("git", ["archive", "--format=tar", commit], { cwd, env, stdio: ["ignore", "pipe", "ignore"] });
    const tar = spawn("tar", ["-x", "-C", dir, "--no-same-owner", "-f", "-"], { env, stdio: ["pipe", "ignore", "ignore"] });
    archive.stdout.pipe(tar.stdin);
    tar.stdin.on("error", () => undefined);
    let archiveOk: boolean | null = null;
    let tarOk: boolean | null = null;
    const done = () => {
      if (archiveOk !== null && tarOk !== null) resolve(archiveOk && tarOk);
    };
    archive.on("close", (code) => ((archiveOk = code === 0), done()));
    tar.on("close", (code) => ((tarOk = code === 0), done()));
    archive.on("error", () => ((archiveOk = false), done()));
    tar.on("error", () => ((tarOk = false), done()));
  });
}

/** With isolation required and no sandbox, commands are refused rather than run as Paperclip's own user. */
export const refusingRunner: CommandRunner = async () => ({
  exitCode: null,
  timedOut: false,
  output: "not run: the checks sandbox is not configured (commands never run as Paperclip's own user)",
});

/**
 * Run an operator-configured command in the task worktree. The environment holds
 * only PATH/HOME/LANG and CI=1: no Paperclip tokens or other keys leak into it.
 */
export function runCommand(command: string, cwd: string, timeoutSeconds: number): Promise<CommandOutcome> {
  return new Promise((resolve) => {
    const child = spawn(command, {
      cwd,
      shell: true,
      detached: true,
      env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", LANG: "C.UTF-8", CI: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    const collect = (chunk: Buffer) => {
      output = (output + chunk.toString("utf8")).slice(-OUTPUT_TAIL_CHARS * 4);
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
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ exitCode: code, timedOut, output: redact(output).slice(-OUTPUT_TAIL_CHARS) });
    });
    child.on("error", () => {
      clearTimeout(timer);
      resolve({ exitCode: null, timedOut, output: "could not start command" });
    });
  });
}

async function commandCheck(
  name: "tests" | "lint",
  command: string | null,
  runner: CommandRunner,
  timeoutSeconds: number,
  commit: string,
): Promise<CheckResult> {
  if (!command) return { name, status: "skipped", summary: name === "tests" ? "NOT TESTED: no test command is set up" : "no command configured" };
  const outcome = await runner(command, timeoutSeconds, commit);
  if (outcome.exitCode === null && !outcome.timedOut) {
    return { name, status: "failed", summary: outcome.output.split("\n")[0] || "could not run", output: outcome.output };
  }
  if (outcome.timedOut) {
    return { name, status: "failed", summary: `timed out after ${timeoutSeconds}s`, output: outcome.output };
  }
  if (outcome.exitCode === 0) return { name, status: "passed", summary: "exit code 0", output: outcome.output };
  return { name, status: "failed", summary: `exit code ${outcome.exitCode}`, output: outcome.output };
}

function describeFindings(findings: SecretFinding[]): string {
  const shown = findings.slice(0, 20).map((f) => `${f.file}${f.line ? `:${f.line}` : ""} (${f.rule})`);
  const more = findings.length > shown.length ? `, and ${findings.length - shown.length} more` : "";
  return `${findings.length} possible secret(s): ${shown.join(", ")}${more}`;
}

/**
 * Run the whole gate on the worktree's current commit: diff size, secret scan,
 * tests, lint. Only committed files count; uncommitted changes are ignored (the
 * owner approves a commit, so that is what is checked). Fails closed on errors.
 */
export async function runChecksGate(
  cwd: string,
  baseRef: string,
  settings: ChecksSettings,
  runner: CommandRunner = localRunner(cwd),
): Promise<ChecksReport> {
  const results: CheckResult[] = [];
  let base: string;
  let head: string;
  try {
    // One commit for every check, fixed now: later commits are not mixed in.
    head = await headSha(cwd);
  } catch {
    return { passed: false, result: "failed", headSha: null, baseRef, results: [{ name: "diff-size", status: "failed", summary: "could not read the worktree's commit" }] };
  }
  try {
    base = await mergeBase(cwd, baseRef, head);
  } catch {
    return {
      passed: false,
      result: "failed",
      headSha: head,
      baseRef,
      results: [{ name: "diff-size", status: "failed", summary: `could not compare with ${baseRef}` }],
    };
  }

  const stats = await diffStats(cwd, base, head);
  const changed = stats.addedLines + stats.removedLines;
  results.push({
    name: "diff-size",
    status: changed <= settings.maxDiffLines ? "passed" : "failed",
    summary: `${changed} changed lines in ${stats.files.length} files (limit ${settings.maxDiffLines})`,
  });

  const findings = [...scanFileNames(stats.files), ...scanAddedLines(await addedLines(cwd, base, head))];
  results.push(
    findings.length === 0
      ? { name: "secret-scan", status: "passed", summary: "no secrets found" }
      : { name: "secret-scan", status: "failed", summary: describeFindings(findings) },
  );

  results.push(await commandCheck("tests", settings.testCommand, runner, settings.timeoutSeconds, head));
  results.push(await commandCheck("lint", settings.lintCommand, runner, settings.timeoutSeconds, head));

  const failed = results.some((r) => r.status === "failed");
  const tested = results.find((r) => r.name === "tests")?.status === "passed";
  const result: GateResult = failed ? "failed" : tested ? "passed" : "not-tested";
  return { passed: result === "passed", result, headSha: head, baseRef, results };
}

export function formatReport(report: ChecksReport): string {
  const icon = (s: CheckStatus) => (s === "passed" ? "PASS" : s === "failed" ? "FAIL" : "SKIP");
  const lines = [
    `# Checks gate: ${gateWord(report.result)}`,
    "",
    `- Commit: \`${report.headSha ?? "unknown"}\` (committed files only; uncommitted changes are not checked)`,
    `- Compared with: \`${report.baseRef}\``,
    "",
    "| Check | Result | Details |",
    "|---|---|---|",
    ...report.results.map((r) => `| ${r.name} | ${icon(r.status)} | ${r.summary.replace(/\|/g, "\\|")} |`),
  ];
  for (const r of report.results) {
    if (r.output && r.status === "failed") {
      lines.push("", `## ${r.name} output (last lines)`, "", "```", r.output.replace(/```/g, "'''"), "```");
    }
  }
  return lines.join("\n");
}

/** How a gate result reads to people. "Not tested" never reads as a pass. */
export function gateWord(result: GateResult): string {
  return result === "passed" ? "PASSED" : result === "failed" ? "FAILED" : "NOT TESTED (no test command is set up)";
}
