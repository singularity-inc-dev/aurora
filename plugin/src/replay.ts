import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { GIT_TIMEOUT_MS } from "./git.js";

const run = promisify(execFile);

/**
 * Merge replay (thin version 1, piece E): every ready branch is test-merged
 * against every other with `git merge-tree --write-tree` (git 2.38 or later).
 * It works on the object database only: no working folder, index or branch
 * changes, and nothing is merged.
 */
export type ReplayResult = { status: "clean" } | { status: "conflict"; files: string[] } | { status: "error"; message: string };

export async function replayMerge(cwd: string, a: string, b: string, options: { timeoutMs?: number } = {}): Promise<ReplayResult> {
  for (const sha of [a, b]) if (!/^[0-9a-f]{40}([0-9a-f]{24})?$/.test(sha)) return { status: "error", message: "not a commit id" };
  try {
    await run("git", ["merge-tree", "--write-tree", "--name-only", "--no-messages", "-z", a, b], {
      cwd,
      maxBuffer: 16 * 1024 * 1024,
      env: { PATH: process.env.PATH ?? "" },
      timeout: options.timeoutMs ?? GIT_TIMEOUT_MS,
      killSignal: "SIGKILL",
    });
    return { status: "clean" };
  } catch (err) {
    const e = err as { code?: unknown; stdout?: string };
    // Exit 1 means conflicts; the output is the tree id, then each conflicted file (NUL-separated).
    if (e.code === 1 && typeof e.stdout === "string") {
      const [tree, ...files] = e.stdout.split("\0").filter(Boolean);
      // A real conflict starts with the merged tree's id; anything else is git failing.
      if (tree && /^[0-9a-f]{40}([0-9a-f]{24})?$/.test(tree.trim())) return { status: "conflict", files: [...new Set(files)].sort() };
    }
    return { status: "error", message: "git could not replay the merge" };
  }
}

/** A finished task whose branch is ready for its owner's decision. */
export interface ReadyBranch {
  taskId: string;
  owner: string;
  title: string;
  identifier: string | null;
  /** The branch head the owner would approve. */
  head: string;
  /** Any checkout of the repository that has the commit (the task's worktree). */
  cwd: string;
}

export interface Conflict {
  a: ReadyBranch;
  b: ReadyBranch;
  files: string[];
}

/** Two branches that git merges cleanly but that both change the same files. */
export type SharedFiles = Conflict;

const SHA = /^[0-9a-f]{40}([0-9a-f]{24})?$/;
const gitOut = async (cwd: string, args: string[]) =>
  (await run("git", args, { cwd, maxBuffer: 16 * 1024 * 1024, env: { PATH: process.env.PATH ?? "" }, timeout: GIT_TIMEOUT_MS, killSignal: "SIGKILL" })).stdout;

/**
 * Files both branches change since they split (their merge base), whether or not
 * git can merge them. Read-only, like the replay. Null when git cannot tell.
 */
export async function changedByBoth(cwd: string, a: string, b: string): Promise<string[] | null> {
  if (!SHA.test(a) || !SHA.test(b)) return null;
  try {
    const base = (await gitOut(cwd, ["merge-base", a, b])).trim();
    if (!SHA.test(base)) return null;
    const files = async (head: string) => new Set((await gitOut(cwd, ["diff", "--name-only", "-z", "--no-renames", base, head, "--"])).split("\0").filter(Boolean));
    const [fa, fb] = await Promise.all([files(a), files(b)]);
    return [...fa].filter((f) => fb.has(f)).sort();
  } catch {
    return null;
  }
}

/**
 * Test-merge each of `mine` against the rest of `mine` and against every one of
 * `others`. Returns the pairs that conflict, the pairs that merge cleanly but
 * both change the same files (`shared`), and the pairs that could not be
 * replayed (for example, branches of different repositories).
 */
export async function replayPairs(
  mine: readonly ReadyBranch[],
  others: readonly ReadyBranch[],
): Promise<{ conflicts: Conflict[]; shared: SharedFiles[]; unreplayed: Array<[ReadyBranch, ReadyBranch]> }> {
  const conflicts: Conflict[] = [];
  const shared: SharedFiles[] = [];
  const unreplayed: Array<[ReadyBranch, ReadyBranch]> = [];
  const pairs: Array<[ReadyBranch, ReadyBranch]> = [];
  mine.forEach((a, i) => {
    for (const b of mine.slice(i + 1)) pairs.push([a, b]);
    for (const b of others) if (b.taskId !== a.taskId) pairs.push([a, b]);
  });
  for (const [a, b] of pairs) {
    if (a.head === b.head) continue;
    const r = await replayMerge(a.cwd, a.head, b.head);
    if (r.status === "conflict") conflicts.push({ a, b, files: r.files });
    else if (r.status === "error") unreplayed.push([a, b]);
    else {
      const both = await changedByBoth(a.cwd, a.head, b.head);
      if (both === null) unreplayed.push([a, b]);
      else if (both.length > 0) shared.push({ a, b, files: both });
    }
  }
  return { conflicts, shared, unreplayed };
}
