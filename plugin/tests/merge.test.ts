import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { isClean, mergeApproved, shortStat } from "../src/merge.js";
import { makeRepoWithWorktree, sh, write } from "./helpers.js";

function commit(dir: string, file: string, content: string): string {
  write(dir, file, content);
  sh(dir, "add", ".");
  sh(dir, "-c", "user.email=t@example.com", "-c", "user.name=T", "commit", "-q", "-m", `edit ${file}`);
  return sh(dir, "rev-parse", "HEAD").trim();
}
const mergesOf = (repo: string, sha: string) =>
  execFileSync("git", ["log", "--merges", "--format=%H %P", "main"], { cwd: repo, encoding: "utf8" })
    .split("\n")
    .filter((l) => l.includes(sha)).length;

describe("mergeApproved", () => {
  it("merges the approved commit into main, with main checked out", async () => {
    const { repo, worktree } = makeRepoWithWorktree();
    const head = commit(worktree, "a.txt", "a\n");
    const res = await mergeApproved({ cwd: worktree, branch: "task", baseRef: "main", expectedHead: head, message: "Merge task" });
    expect(res).toMatchObject({ ok: true, alreadyMerged: false });
    expect(mergesOf(repo, head)).toBe(1);
    expect(await isClean(repo)).toBe(true); // the shared checkout follows main cleanly
  });

  it("a second approve does not merge again", async () => {
    const { repo, worktree } = makeRepoWithWorktree();
    const head = commit(worktree, "a.txt", "a\n");
    const req = { cwd: worktree, branch: "task", baseRef: "main", expectedHead: head, message: "Merge task" };
    await mergeApproved(req);
    expect(await mergeApproved(req)).toMatchObject({ ok: true, alreadyMerged: true });
    expect(mergesOf(repo, head)).toBe(1);
  });

  it("refuses when the branch moved after the email", async () => {
    const { repo, worktree } = makeRepoWithWorktree();
    const approved = commit(worktree, "a.txt", "a\n");
    commit(worktree, "b.txt", "sneaky\n");
    const res = await mergeApproved({ cwd: worktree, branch: "task", baseRef: "main", expectedHead: approved, message: "m" });
    expect(res).toMatchObject({ ok: false, reason: "branch-changed" });
    expect(mergesOf(repo, approved)).toBe(0);
  });

  it("refuses a conflicting merge and leaves main unchanged", async () => {
    const { repo, worktree } = makeRepoWithWorktree();
    const head = commit(worktree, "README.md", "task version\n");
    const mainBefore = commit(repo, "README.md", "main version\n");
    const res = await mergeApproved({ cwd: worktree, branch: "task", baseRef: "main", expectedHead: head, message: "m" });
    expect(res).toMatchObject({ ok: false, reason: "conflict" });
    expect(sh(repo, "rev-parse", "main").trim()).toBe(mainBefore);
  });

  it("works when main is not checked out anywhere", async () => {
    const { repo, worktree } = makeRepoWithWorktree();
    sh(repo, "checkout", "-q", "-b", "other");
    const head = commit(worktree, "a.txt", "a\n");
    const res = await mergeApproved({ cwd: worktree, branch: "task", baseRef: "main", expectedHead: head, message: "m" });
    expect(res.ok).toBe(true);
    expect(mergesOf(repo, head)).toBe(1);
  });

  it("describes the change in one line", async () => {
    const { worktree } = makeRepoWithWorktree();
    const head = commit(worktree, "a.txt", "a\nb\n");
    expect(await shortStat(worktree, "main", head)).toBe("1 file changed, 2 insertions(+)");
  });
});
