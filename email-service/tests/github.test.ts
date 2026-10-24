import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { githubClient, scrub } from "../src/github.ts";
import type { PublishRequest } from "../src/paperclip.ts";
import { createFakeGithub, seedFrom, type FakeGithub } from "./fake-github.ts";

// Built at runtime so no token-shaped text is committed.
const TOKEN = ["gh", "p_"].join("") + "T0k3nV4lu3".repeat(4);
const sh = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.email=t@example.com", "-c", "user.name=T", ...args], { cwd, encoding: "utf8" }).trim();

let fake: FakeGithub | null = null;
afterEach(() => fake?.server.close());

/** A local repo (the Paperclip project) with a task worktree, and GitHub seeded with its main. */
async function setup() {
  const root = mkdtempSync(path.join(tmpdir(), "vt-gh-"));
  const repo = path.join(root, "repo");
  execFileSync("git", ["init", "-q", "-b", "main", repo]);
  writeFileSync(path.join(repo, "README.md"), "hi\n");
  sh(repo, "add", ".");
  sh(repo, "commit", "-q", "-m", "init");
  const worktree = path.join(root, "wt");
  sh(repo, "worktree", "add", "-q", "-b", "vt/T-1-greeting", worktree, "main");
  writeFileSync(path.join(worktree, "greeting.txt"), "hello\n");
  sh(worktree, "add", ".");
  sh(worktree, "commit", "-q", "-m", "Add greeting");
  const head = sh(worktree, "rev-parse", "HEAD");

  fake = createFakeGithub({ dir: path.join(root, "github"), repo: "acme/app", token: TOKEN });
  await new Promise<void>((r) => fake!.server.listen(0, "127.0.0.1", r));
  seedFrom(fake, repo);
  const base = `http://127.0.0.1:${(fake.server.address() as AddressInfo).port}`;
  const client = (token = TOKEN) => githubClient({ token, apiUrl: `${base}/api`, gitUrl: base, stateDir: path.join(root, "state") }, fetch, async () => undefined);
  const req: PublishRequest = { repo: "acme/app", worktree, branch: "vt/T-1-greeting", baseBranch: "main", expectedHead: head, title: "T-1: Add greeting", body: "Approved." };
  return { root, repo, worktree, head, client, req, fake: fake! };
}

describe("publish to GitHub (Approve)", () => {
  it("pushes exactly the approved commit, opens a pull request and squash-merges it", async () => {
    const t = await setup();
    const result = await t.client().publish(t.req);
    expect(result).toMatchObject({ result: "merged", number: 1, url: "https://github.example/acme/app/pull/1" });
    expect(t.fake.git("rev-parse", "refs/heads/vt/T-1-greeting").trim()).toBe(t.head);
    // A squash merge: one new commit on main with the change, not a merge commit.
    expect(t.fake.git("log", "--format=%s|%P", "-1", "main").trim()).toMatch(/^T-1: Add greeting \(#1\)\|[0-9a-f]{40}$/);
    expect(t.fake.git("show", "main:greeting.txt")).toBe("hello\n");
    expect(t.fake.pulls[0]).toMatchObject({ state: "closed", merged: true });
  });

  it("branch protection blocks the merge: the pull request stays open and waits for review", async () => {
    const t = await setup();
    t.fake.protection = true;
    const result = await t.client().publish(t.req);
    expect(result).toEqual({ result: "waiting", number: 1, url: "https://github.example/acme/app/pull/1", reason: "At least 1 approving review is required by reviewers with write access." });
    expect(t.fake.pulls[0]).toMatchObject({ state: "open", merged: false });
    expect(() => t.fake.git("show", "main:greeting.txt")).toThrow();
    // A reviewer merges it on GitHub; the status check sees it.
    t.fake.protection = false;
    expect(await t.client().status("acme/app", { taskId: "x", number: 1, url: "", headSha: t.head })).toEqual({ state: "open", mergeSha: null });
    await fetch(`http://127.0.0.1:${(t.fake.server.address() as AddressInfo).port}/__control/merge/1`, { method: "POST" });
    expect((await t.client().status("acme/app", { taskId: "x", number: 1, url: "", headSha: t.head })).state).toBe("merged");
  });

  it("a second Approve of the same branch reuses the open pull request instead of opening another", async () => {
    const t = await setup();
    t.fake.protection = true;
    await t.client().publish(t.req);
    const again = await t.client().publish(t.req);
    expect(again).toMatchObject({ result: "waiting", number: 1 });
    expect(t.fake.pulls).toHaveLength(1);
  });

  it("refuses a branch that changed after the email; nothing reaches GitHub", async () => {
    const t = await setup();
    writeFileSync(path.join(t.worktree, "late.txt"), "late\n");
    sh(t.worktree, "add", ".");
    sh(t.worktree, "commit", "-q", "-m", "late");
    const result = await t.client().publish(t.req);
    expect(result).toEqual({ result: "failed", message: "could not push the task branch: the branch changed after the email was sent" });
    expect(t.fake.requests).toEqual([]);
  });

  it("never overwrites a branch on GitHub that has other commits (no force push)", async () => {
    const t = await setup();
    // Someone pushed a different commit to the same branch name on GitHub.
    t.fake.git("update-ref", "refs/heads/vt/T-1-greeting", t.fake.git("rev-parse", "main").trim());
    const other = t.fake.git("-c", "user.name=O", "-c", "user.email=o@example.com", "commit-tree", "-p", "main", "-m", "theirs", t.fake.git("rev-parse", "main^{tree}").trim()).trim();
    t.fake.git("update-ref", "refs/heads/vt/T-1-greeting", other);
    const result = await t.client().publish(t.req);
    expect(result.result).toBe("failed");
    expect(t.fake.git("rev-parse", "refs/heads/vt/T-1-greeting").trim()).toBe(other);
  });

  it("a wrong token gets nothing done, and the error never shows the token", async () => {
    const t = await setup();
    const wrong = ["gh", "p_"].join("") + "Wr0ng".repeat(8);
    const result = await t.client(wrong).publish(t.req);
    expect(result.result).toBe("failed");
    expect(JSON.stringify(result)).not.toContain(wrong);
    expect(t.fake.pulls).toEqual([]);
  });

  it("refuses branch details that could be read as options or paths", async () => {
    const t = await setup();
    for (const bad of [{ branch: "--upload-pack=x" }, { branch: "a/../../b" }, { repo: "acme/app; rm" }, { expectedHead: "HEAD" }, { branch: "main" }]) {
      expect((await t.client().publish({ ...t.req, ...bad })).result).toBe("failed");
    }
    expect(t.fake.requests).toEqual([]);
  });
});

describe("the GitHub token stays secret", () => {
  it("never appears in any git command line (other users on the server can see command lines)", async () => {
    const t = await setup();
    // A git wrapper first on PATH records every command line, then runs the real git.
    const bin = path.join(t.root, "bin");
    execFileSync("mkdir", ["-p", bin]);
    const log = path.join(t.root, "argv.log");
    const realGit = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
    writeFileSync(path.join(bin, "git"), `#!/bin/sh\nprintf '%s\\n' "$*" >> '${log}'\nexec '${realGit}' "$@"\n`);
    chmodSync(path.join(bin, "git"), 0o755);
    const oldPath = process.env.PATH;
    process.env.PATH = `${bin}:${oldPath}`;
    try {
      expect((await t.client().publish(t.req)).result).toBe("merged");
    } finally {
      process.env.PATH = oldPath;
    }
    const argv = readFileSync(log, "utf8");
    expect(argv).toContain("push");
    expect(argv).not.toContain(TOKEN);
    expect(argv).not.toContain(Buffer.from(`x-access-token:${TOKEN}`).toString("base64"));
    // ...and every request GitHub saw carried it (so it really was used).
    expect(t.fake.requests.length).toBeGreaterThan(3);
    expect(t.fake.requests.every((r) => r.authorized)).toBe(true);
  });

  it("scrub hides the token in any text", () => {
    expect(scrub(`remote: bad ${TOKEN} here`, TOKEN)).toBe("remote: bad [hidden] here");
  });
});
