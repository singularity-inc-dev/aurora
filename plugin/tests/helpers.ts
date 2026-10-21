import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/** Fake-but-realistic token built at runtime so no token-shaped text is committed. */
export function fakeGithubToken(): string {
  return ["gh", "p_"].join("") + "A1b2C3d4".repeat(5);
}

export function sh(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

/** A repo with `main`, and a worktree on branch `task` checked out from it. */
export function makeRepoWithWorktree(): { repo: string; worktree: string } {
  const root = mkdtempSync(path.join(tmpdir(), "vt-checks-"));
  const repo = path.join(root, "repo");
  mkdirSync(repo);
  sh(repo, "init", "-q", "-b", "main");
  sh(repo, "config", "user.email", "test@example.com");
  sh(repo, "config", "user.name", "Test");
  writeFileSync(path.join(repo, "README.md"), "hello\n");
  sh(repo, "add", ".");
  sh(repo, "commit", "-q", "-m", "init");
  const worktree = path.join(root, "wt");
  sh(repo, "worktree", "add", "-q", "-b", "task", worktree, "main");
  return { repo, worktree };
}

export function write(dir: string, file: string, content: string): void {
  mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
  writeFileSync(path.join(dir, file), content);
}
