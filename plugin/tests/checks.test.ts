import { describe, expect, it } from "vitest";
import { formatReport, gateWord, localRunner, runChecksGate, runCommand } from "../src/checks.js";
import type { ChecksSettings } from "../src/config.js";
import { fakeGithubToken, makeRepoWithWorktree, sh, write } from "./helpers.js";

const base: ChecksSettings = { testCommand: null, lintCommand: null, maxDiffLines: 400, timeoutSeconds: 30, sandbox: null };
const byName = (r: Awaited<ReturnType<typeof runChecksGate>>, n: string) => r.results.find((x) => x.name === n)!;
const commit = (worktree: string, msg = "work") => {
  sh(worktree, "add", "-A");
  sh(worktree, "commit", "-q", "-m", msg);
};

describe("runChecksGate", () => {
  it("passes a small committed change when the tests pass", async () => {
    const { worktree } = makeRepoWithWorktree();
    write(worktree, "src/a.ts", "export const a = 1;\n");
    write(worktree, "src/b.ts", "export const b = 2;\n");
    commit(worktree);
    const report = await runChecksGate(worktree, "main", { ...base, testCommand: "true" });
    expect(report).toMatchObject({ passed: true, result: "passed" });
    expect(byName(report, "diff-size").summary).toBe("2 changed lines in 2 files (limit 400)");
    expect(report.headSha).toMatch(/^[0-9a-f]{40}$/);
  });

  it("no test command means NOT TESTED, never passed", async () => {
    const { worktree } = makeRepoWithWorktree();
    write(worktree, "src/a.ts", "export const a = 1;\n");
    commit(worktree);
    const report = await runChecksGate(worktree, "main", base);
    expect(report).toMatchObject({ passed: false, result: "not-tested" });
    expect(byName(report, "tests")).toMatchObject({ status: "skipped", summary: "NOT TESTED: no test command is set up" });
    expect(formatReport(report)).toContain("# Checks gate: NOT TESTED (no test command is set up)");
    expect(formatReport(report)).not.toContain("PASSED");
    expect(gateWord("not-tested")).not.toMatch(/pass/i);
  });

  it("the handover note's files: a committed change outside them fails the gate, renames included", async () => {
    const { worktree } = makeRepoWithWorktree();
    write(worktree, "src/ui/button.tsx", "export {};\n");
    commit(worktree);
    const inside = await runChecksGate(worktree, "main", { ...base, testCommand: "true" }, undefined, ["src/ui"]);
    expect(inside).toMatchObject({ passed: true, result: "passed" });
    expect(byName(inside, "files")).toMatchObject({ status: "passed", summary: "only the files the handover note allows" });

    write(worktree, "src/api/secret-door.ts", "export {};\n");
    sh(worktree, "mv", "src/ui/button.tsx", "src/ui-old.tsx");
    commit(worktree);
    const outside = await runChecksGate(worktree, "main", { ...base, testCommand: "true" }, undefined, ["src/ui"]);
    expect(outside).toMatchObject({ passed: false, result: "failed" });
    expect(byName(outside, "files")).toMatchObject({ status: "failed", summary: "2 file(s) outside the handover note: `src/api/secret-door.ts`, `src/ui-old.tsx`" });
    // No note (e.g. a teammate's hand-off ticket): no files check.
    expect((await runChecksGate(worktree, "main", { ...base, testCommand: "true" })).results.map((r) => r.name)).not.toContain("files");
  });

  it("a failure still wins over not tested", async () => {
    const { worktree } = makeRepoWithWorktree();
    write(worktree, "big.txt", "x\n".repeat(50));
    commit(worktree);
    expect((await runChecksGate(worktree, "main", { ...base, maxDiffLines: 10 })).result).toBe("failed");
  });

  it("uses only committed files: uncommitted and untracked changes are not checked", async () => {
    const { worktree } = makeRepoWithWorktree();
    write(worktree, "src/a.ts", "export const a = 1;\n");
    commit(worktree);
    // After the commit: a big untracked file, an uncommitted edit, and a file the tests look for.
    write(worktree, "big.txt", "x\n".repeat(50));
    write(worktree, "src/a.ts", "export const a = 2;\nexport const more = 3;\n");
    write(worktree, "PROOF", "made by hand, not committed\n");
    const report = await runChecksGate(worktree, "main", { ...base, maxDiffLines: 10, testCommand: "test ! -e PROOF && test ! -e big.txt && grep -q 'a = 1' src/a.ts" });
    expect(byName(report, "diff-size")).toMatchObject({ status: "passed", summary: "1 changed lines in 1 files (limit 10)" });
    expect(byName(report, "tests").status).toBe("passed");
    expect(formatReport(report)).toContain("committed files only");
  });

  it("an agent that committed nothing gets NO CHANGES TO CHECK, never a pass on the unchanged base", async () => {
    const { worktree } = makeRepoWithWorktree();
    write(worktree, "src/uncommitted.ts", "export {};\n");
    const report = await runChecksGate(worktree, "main", { ...base, testCommand: "true", lintCommand: "true" });
    expect(report).toMatchObject({ passed: false, result: "no-changes" });
    expect(report.results).toEqual([expect.objectContaining({ status: "failed", summary: "no changes to check: nothing is committed beyond main" })]);
    expect(formatReport(report)).toContain("# Checks gate: NO CHANGES TO CHECK");
    // Commits that add and then remove the same change also leave nothing to check.
    sh(worktree, "clean", "-fdq");
    write(worktree, "tmp.txt", "x\n");
    commit(worktree, "add");
    sh(worktree, "rm", "-q", "tmp.txt");
    sh(worktree, "commit", "-q", "-m", "remove");
    expect((await runChecksGate(worktree, "main", { ...base, testCommand: "true" })).result).toBe("no-changes");
  });

  it("an uncommitted file cannot make failing tests pass", async () => {
    const { worktree } = makeRepoWithWorktree();
    write(worktree, "src/a.ts", "export const a = 1;\n");
    commit(worktree);
    write(worktree, "PROOF", "untracked\n");
    const report = await runChecksGate(worktree, "main", { ...base, testCommand: "test -f PROOF" });
    expect(byName(report, "tests").status).toBe("failed");
    expect(report.result).toBe("failed");
  });

  it("fails when the change is bigger than the limit", async () => {
    const { worktree } = makeRepoWithWorktree();
    write(worktree, "big.txt", "x\n".repeat(50));
    commit(worktree);
    const report = await runChecksGate(worktree, "main", { ...base, maxDiffLines: 10 });
    expect(report.passed).toBe(false);
    expect(byName(report, "diff-size").status).toBe("failed");
  });

  it("fails on a secret without printing it", async () => {
    const { worktree } = makeRepoWithWorktree();
    const token = fakeGithubToken();
    write(worktree, "src/config.ts", `export const t = "${token}";\n`);
    commit(worktree);
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
    write(worktree, "src/a.ts", "export const a = 1;\n");
    commit(worktree);
    const report = await runChecksGate(worktree, "main", { ...base, testCommand: "true", lintCommand: "echo lint broke; exit 3" });
    expect(byName(report, "tests").status).toBe("passed");
    expect(byName(report, "lint")).toMatchObject({ status: "failed", summary: "exit code 3" });
    expect(formatReport(report)).toContain("lint broke");
    expect(report.passed).toBe(false);
  });

  it("the local runner runs in a fresh copy of the commit, without .git, and removes it", async () => {
    const { worktree } = makeRepoWithWorktree();
    const head = sh(worktree, "rev-parse", "HEAD").trim();
    const out = await localRunner(worktree)("test -f README.md && test ! -e .git && pwd", 10, head);
    expect(out.exitCode).toBe(0);
    expect(out.output.trim()).not.toBe(worktree);
    expect((await localRunner(worktree)("true", 10, "not-a-commit")).exitCode).toBeNull();
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
