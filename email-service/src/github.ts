import { execFile } from "node:child_process";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { PublishRequest, PublishResult, WaitingPullRequest } from "./paperclip.ts";

const run = promisify(execFile);

export interface GithubSettings {
  /** Owner's token (push + pull requests). Never logged, never in a command line. */
  token: string;
  apiUrl: string;
  gitUrl: string;
  stateDir: string;
}

/** Remove the token from any text before it is shown or logged. */
export function scrub(text: string, token: string): string {
  return token ? text.split(token).join("[hidden]") : text;
}

/**
 * Run git with the token passed as an HTTP header through environment config
 * (GIT_CONFIG_*), so it never appears in the command line other users can see.
 */
async function git(cwd: string, args: string[], token: string | null = null): Promise<string> {
  // Only the settings below apply: no user or system git config can add credentials or hooks.
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH ?? "",
    HOME: process.env.HOME ?? "/nonexistent",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
    LANG: "C",
  };
  let n = 0;
  const conf = (key: string, value: string) => {
    env[`GIT_CONFIG_KEY_${n}`] = key;
    env[`GIT_CONFIG_VALUE_${n}`] = value;
    n += 1;
  };
  // Worktrees belong to the Paperclip user; reading them is all this service does with them.
  conf("safe.directory", "*");
  if (token) conf("http.extraHeader", `Authorization: Basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`);
  env.GIT_CONFIG_COUNT = String(n);
  try {
    const { stdout } = await run("git", args, { cwd, env, maxBuffer: 16 * 1024 * 1024 });
    return stdout;
  } catch (err) {
    const e = err as { stderr?: string; message?: string };
    throw new Error(scrub((e.stderr || e.message || "git failed").trim().split("\n").slice(-1)[0] ?? "git failed", token ?? ""));
  }
}

const BRANCH_RE = /^[A-Za-z0-9._/-]{1,200}$/;
const SHA_RE = /^[0-9a-f]{40}$/;
const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

export function githubClient(s: GithubSettings, fetchImpl: typeof fetch = fetch, sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))) {
  async function api<T>(method: string, route: string, body?: unknown): Promise<{ status: number; body: T }> {
    const res = await fetchImpl(`${s.apiUrl}${route}`, {
      method,
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${s.token}`,
        "x-github-api-version": "2022-11-28",
        "user-agent": "vision-and-tom",
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const text = await res.text();
    let parsed: unknown = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = null;
    }
    return { status: res.status, body: parsed as T };
  }
  const message = (body: unknown) => scrub(String((body as { message?: unknown } | null)?.message ?? "no details"), s.token).slice(0, 200);

  /** Copy exactly the approved commit from the task's worktree into our own mirror, then push it. */
  async function push(req: PublishRequest): Promise<void> {
    const mirror = path.join(s.stateDir, "mirrors", `${req.repo.replace("/", "__")}.git`);
    await mkdir(mirror, { recursive: true });
    await git(mirror, ["init", "-q", "--bare"]);
    const local = `refs/vt/${req.branch}`;
    await git(mirror, ["fetch", "-q", "--no-tags", req.worktree, `+refs/heads/${req.branch}:${local}`]);
    const fetched = (await git(mirror, ["rev-parse", local])).trim();
    if (fetched !== req.expectedHead) throw new Error("the branch changed after the email was sent");
    // No "+" and no --force: an existing branch on GitHub with other commits is refused, never overwritten.
    await git(mirror, ["push", "-q", `${s.gitUrl}/${req.repo}.git`, `${req.expectedHead}:refs/heads/${req.branch}`], s.token);
  }

  async function findOrOpenPullRequest(req: PublishRequest): Promise<{ number: number; url: string }> {
    const owner = req.repo.split("/")[0]!;
    const open = await api<Array<{ number: number; html_url: string; head?: { sha?: string } }>>(
      "GET",
      `/repos/${req.repo}/pulls?state=open&head=${encodeURIComponent(`${owner}:${req.branch}`)}&base=${encodeURIComponent(req.baseBranch)}`,
    );
    const existing = open.status === 200 && Array.isArray(open.body) ? open.body[0] : undefined;
    if (existing) return { number: existing.number, url: existing.html_url };
    const created = await api<{ number?: number; html_url?: string }>("POST", `/repos/${req.repo}/pulls`, {
      title: req.title.slice(0, 250),
      head: req.branch,
      base: req.baseBranch,
      body: req.body,
    });
    if (created.status !== 201 || !created.body?.number || !created.body.html_url) throw new Error(`GitHub did not open the pull request (${created.status}: ${message(created.body)})`);
    return { number: created.body.number, url: created.body.html_url };
  }

  async function publish(req: PublishRequest): Promise<PublishResult> {
    if (!REPO_RE.test(req.repo) || !BRANCH_RE.test(req.branch) || !BRANCH_RE.test(req.baseBranch) || !SHA_RE.test(req.expectedHead) || req.branch.includes("..")) {
      return { result: "failed", message: "the task's branch details are not valid" };
    }
    if (req.branch === req.baseBranch) return { result: "failed", message: "the task branch is the base branch" };
    try {
      await push(req);
    } catch (err) {
      return { result: "failed", message: `could not push the task branch: ${scrub(err instanceof Error ? err.message : "git failed", s.token)}` };
    }
    let pr: { number: number; url: string };
    try {
      pr = await findOrOpenPullRequest(req);
    } catch (err) {
      return { result: "failed", message: scrub(err instanceof Error ? err.message : "GitHub error", s.token) };
    }
    for (let attempt = 1; ; attempt += 1) {
      const merge = await api<{ merged?: boolean; sha?: string; message?: string }>("PUT", `/repos/${req.repo}/pulls/${pr.number}/merge`, {
        merge_method: "squash",
        // GitHub refuses (409) if the pull request head is no longer the approved commit.
        sha: req.expectedHead,
        commit_title: `${req.title} (#${pr.number})`.slice(0, 250),
      });
      if (merge.status === 200 && merge.body?.merged && merge.body.sha) return { result: "merged", number: pr.number, url: pr.url, mergeSha: merge.body.sha };
      if (merge.status === 409) return { result: "failed", message: "the pull request changed on GitHub after the email was sent" };
      if (merge.status === 405 || merge.status === 422) {
        // GitHub may still be computing mergeability right after opening; ask twice more before calling it blocked.
        if (attempt < 3) {
          const state = await api<{ mergeable?: boolean | null }>("GET", `/repos/${req.repo}/pulls/${pr.number}`);
          if (state.body?.mergeable === null) {
            await sleep(2000);
            continue;
          }
        }
        return { result: "waiting", number: pr.number, url: pr.url, reason: message(merge.body) };
      }
      return { result: "failed", message: `GitHub answered ${merge.status} to the merge: ${message(merge.body)}` };
    }
  }

  return {
    /**
     * Approve in GitHub mode: push the task branch, open a pull request, and
     * squash-merge it only if its head is still the approved commit. When
     * branch protection blocks the merge, the pull request stays open and
     * waits for review.
     */
    publish,

    /**
     * Finish an approval that was interrupted (a crash) between the owner's tap
     * and the report back. If GitHub already merged the approved commit, that is
     * the result; if its pull request was closed, the approval is given up; else
     * the publish runs again, which is safe to repeat (same commit, no force
     * push, the open pull request is reused, GitHub merges only that head).
     * Throws when GitHub cannot be asked, so the next round tries again.
     */
    async resume(req: PublishRequest): Promise<PublishResult> {
      if (!REPO_RE.test(req.repo) || !BRANCH_RE.test(req.branch) || !BRANCH_RE.test(req.baseBranch) || !SHA_RE.test(req.expectedHead)) {
        return { result: "failed", message: "the task's branch details are not valid" };
      }
      const owner = req.repo.split("/")[0]!;
      const list = await api<Array<{ number?: number; html_url?: string; state?: string; merged_at?: string | null; merge_commit_sha?: string | null; head?: { sha?: string } }>>(
        "GET",
        `/repos/${req.repo}/pulls?state=all&per_page=100&head=${encodeURIComponent(`${owner}:${req.branch}`)}&base=${encodeURIComponent(req.baseBranch)}`,
      );
      if (list.status !== 200 || !Array.isArray(list.body)) throw new Error(`GitHub answered ${list.status} when listing pull requests`);
      const approved = list.body.filter((p) => p.head?.sha === req.expectedHead && typeof p.number === "number" && typeof p.html_url === "string");
      const merged = approved.find((p) => p.merged_at);
      if (merged) return { result: "merged", number: merged.number!, url: merged.html_url!, mergeSha: merged.merge_commit_sha ?? "" };
      if (approved.length > 0 && approved.every((p) => p.state === "closed")) return { result: "failed", message: "its pull request was closed on GitHub without merging" };
      return publish(req);
    },

    /** Has a waiting pull request been merged or closed on GitHub? */
    async status(repo: string, pr: WaitingPullRequest): Promise<{ state: "open" | "merged" | "closed"; mergeSha: string | null }> {
      if (!REPO_RE.test(repo)) throw new Error("repository name is not valid");
      const res = await api<{ state?: string; merged?: boolean; merge_commit_sha?: string | null }>("GET", `/repos/${repo}/pulls/${pr.number}`);
      if (res.status !== 200) throw new Error(`GitHub answered ${res.status} for pull request #${pr.number}`);
      if (res.body?.merged) return { state: "merged", mergeSha: res.body.merge_commit_sha ?? null };
      return { state: res.body?.state === "closed" ? "closed" : "open", mergeSha: null };
    },
  };
}

export type GithubClient = ReturnType<typeof githubClient>;
