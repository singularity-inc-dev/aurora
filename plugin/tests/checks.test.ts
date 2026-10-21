import { describe, expect, it } from "vitest";
import { formatReport, runChecksGate, runCommand } from "../src/checks.js";
import type { ChecksSettings } from "../src/config.js";
import { fakeGithubToken, makeRepoWithWorktree, sh, write } from "./helpers.js";

const base: ChecksSettings = { testCommand: null, lintCommand: null, maxDiffLines: 400, timeoutSeconds: 30 };
const byName = (r: Awaited<ReturnType<typeof runChecksGate>>, n: string) => r.results.find((x) => x.name === n)!;

describe("runChecksGate", () => {
  it("passes a small clean change, committed or not", async () => {
    const { worktree } = makeRepoWithWorktree();
    write(worktree, "src/a.ts", "export const a = 1;\n");
    sh(worktree, "add", ".");
    sh(worktree, "commit", "-q", "-m", "a");
    write(worktree, "src/b.ts", "export const b = 2;\n");
    const report = await runChecksGate(worktree, "main", base);
    expect(report.passed).toBe(true);
    expect(byName(report, "diff-size").summary).toBe("2 changed lines in 2 files (limit 400)");
    expect(byName(report, "tests").status).toBe("skipped");
    expect(report.headSha).toMatch(/^[0-9a-f]{40}$/);
  });

  it("fails when the change is bigger than the limit", async () => {
    const { worktree } = makeRepoWithWorktree();
    write(worktree, "big.txt", "x\n".repeat(50));
    const report = await runChecksGate(worktree, "main", { ...base, maxDiffLines: 10 });
    expect(report.passed).toBe(false);
    expect(byName(report, "diff-size").status).toBe("failed");
  });

  it("fails on a secret without printing it", async () => {
    const { worktree } = makeRepoWithWorktree();
    const token = fakeGithubToken();
    write(worktree, "src/config.ts", `export const t = "${token}";\n`);
    const report = await runChecksGate(worktree, "main", base);
    expect(byName(report, "secret-scan").status).toBe("failed");
    expect(byName(report, "secret-scan").summary).toContain("src/config.ts:1 (github-token)");
    expect(formatReport(report)).not.toContain(token);
  });

  it("fails on a committed .env file", async () => {
    const { worktree } = makeRepoWithWorktree();
    write(worktree, ".env", "PORT=3000\n");
    sh(worktree, "add", "-f", ".env");
    sh(worktree, "commit", "-q", "-m", "env");
    const report = await runChecksGate(worktree, "main", base);
    expect(byName(report, "secret-scan").summary).toContain("forbidden-file");
  });

  it("runs test and lint commands and reports failures", async () => {
    const { worktree } = makeRepoWithWorktree();
    const report = await runChecksGate(worktree, "main", { ...base, testCommand: "true", lintCommand: "echo lint broke; exit 3" });
    expect(byName(report, "tests").status).toBe("passed");
    expect(byName(report, "lint")).toMatchObject({ status: "failed", summary: "exit code 3" });
    expect(formatReport(report)).toContain("lint broke");
    expect(report.passed).toBe(false);
  });

  it("fails closed when the base branch does not exist", async () => {
    const { worktree } = makeRepoWithWorktree();
    const report = await runChecksGate(worktree, "no-such-branch", base);
    expect(report.passed).toBe(false);
  });
});

describe("runCommand", () => {
  it("does not pass Paperclip or other keys into the command", async () => {
    process.env.VT_TEST_SHOULD_NOT_LEAK = "leak";
    const out = await runCommand("env", process.cwd(), 10);
    delete process.env.VT_TEST_SHOULD_NOT_LEAK;
    expect(out.output).not.toContain("VT_TEST_SHOULD_NOT_LEAK");
    expect(out.output).toContain("CI=1");
  });

  it("stops a command that runs too long", async () => {
    const started = Date.now();
    const out = await runCommand("sleep 30", process.cwd(), 1);
    expect(out.timedOut).toBe(true);
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  it("redacts secrets printed by a command", async () => {
    const token = fakeGithubToken();
    const out = await runCommand(`echo ${token}`, process.cwd(), 10);
    expect(out.output).not.toContain(token);
  });
});
