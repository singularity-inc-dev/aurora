import { spawn } from "node:child_process";
import type { ChecksSettings } from "./config.js";
import { addedLines, diffStats, headSha, mergeBase } from "./git.js";
import { redact, scanAddedLines, scanFileNames, type SecretFinding } from "./secretscan.js";

export type CheckStatus = "passed" | "failed" | "skipped";

export interface CheckResult {
  name: "diff-size" | "secret-scan" | "tests" | "lint";
  status: CheckStatus;
  summary: string;
  /** Tail of command output, already redacted. */
  output?: string;
}

export interface ChecksReport {
  passed: boolean;
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
  cwd: string,
  timeoutSeconds: number,
): Promise<CheckResult> {
  if (!command) return { name, status: "skipped", summary: "no command configured" };
  const outcome = await runCommand(command, cwd, timeoutSeconds);
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

/** Run the whole gate: diff size, secret scan, tests, lint. Fails closed on errors. */
export async function runChecksGate(cwd: string, baseRef: string, settings: ChecksSettings): Promise<ChecksReport> {
  const results: CheckResult[] = [];
  let base: string;
  let head: string | null = null;
  try {
    head = await headSha(cwd);
    base = await mergeBase(cwd, baseRef);
  } catch {
    return {
      passed: false,
      headSha: head,
      baseRef,
      results: [{ name: "diff-size", status: "failed", summary: `could not compare with ${baseRef}` }],
    };
  }

  const stats = await diffStats(cwd, base);
  const changed = stats.addedLines + stats.removedLines;
  results.push({
    name: "diff-size",
    status: changed <= settings.maxDiffLines ? "passed" : "failed",
    summary: `${changed} changed lines in ${stats.files.length} files (limit ${settings.maxDiffLines})`,
  });

  const findings = [...scanFileNames(stats.files), ...scanAddedLines(await addedLines(cwd, base))];
  results.push(
    findings.length === 0
      ? { name: "secret-scan", status: "passed", summary: "no secrets found" }
      : { name: "secret-scan", status: "failed", summary: describeFindings(findings) },
  );

  results.push(await commandCheck("tests", settings.testCommand, cwd, settings.timeoutSeconds));
  results.push(await commandCheck("lint", settings.lintCommand, cwd, settings.timeoutSeconds));

  return { passed: results.every((r) => r.status !== "failed"), headSha: head, baseRef, results };
}

export function formatReport(report: ChecksReport): string {
  const icon = (s: CheckStatus) => (s === "passed" ? "PASS" : s === "failed" ? "FAIL" : "SKIP");
  const lines = [
    `# Checks gate: ${report.passed ? "PASSED" : "FAILED"}`,
    "",
    `- Commit: \`${report.headSha ?? "unknown"}\``,
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
