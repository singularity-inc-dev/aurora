import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { git } from "./git.js";

export type MergeResult =
  | { ok: true; mergeSha: string; alreadyMerged: boolean }
  | { ok: false; reason: "branch-changed" | "base-missing" | "conflict" | "base-moved" | "error"; message: string };

export interface MergeRequest {
  /** Any checkout of the repository (the task's worktree). */
  cwd: string;
  branch: string;
  baseRef: string;
  /** Branch head shown in the email: the version the owner approved. */
  expectedHead: string;
  message: string;
}

const IDENTITY = ["-c", "user.name=Vision and Tom", "-c", "user.email=vision-and-tom@localhost"];

async function revParse(cwd: string, ref: string): Promise<string | null> {
  try {
    return (await git(cwd, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`])).trim() || null;
  } catch {
    return null;
  }
}

async function isAncestor(cwd: string, a: string, b: string): Promise<boolean> {
  try {
    await git(cwd, ["merge-base", "--is-ancestor", a, b]);
    return true;
  } catch {
    return false;
  }
}

/** Path of the worktree that has `branch` checked out, if any. */
async function checkedOutAt(cwd: string, branch: string): Promise<string | null> {
  const out = await git(cwd, ["worktree", "list", "--porcelain"]);
  let current: string | null = null;
  for (const line of out.split("\n")) {
    if (line.startsWith("worktree ")) current = line.slice(9);
    if (line === `branch refs/heads/${branch}` && current) return current;
  }
  return null;
}

/**
 * Merge an approved task branch into its base branch, only if the branch is
 * still exactly the version the owner approved.
 */
export async function mergeApproved(req: MergeRequest): Promise<MergeResult> {
  const head = await revParse(req.cwd, `refs/heads/${req.branch}`);
  if (head !== req.expectedHead) {
    return { ok: false, reason: "branch-changed", message: "the branch changed after the email was sent" };
  }
  const base = await revParse(req.cwd, `refs/heads/${req.baseRef}`);
  if (!base) return { ok: false, reason: "base-missing", message: `base branch ${req.baseRef} not found` };
  if (await isAncestor(req.cwd, req.expectedHead, base)) return { ok: true, mergeSha: base, alreadyMerged: true };

  const tmp = await mkdtemp(path.join(tmpdir(), "vt-merge-"));
  try {
    await git(req.cwd, ["worktree", "add", "--detach", tmp, base]);
    try {
      await git(tmp, [...IDENTITY, "merge", "--no-ff", "--no-edit", "-m", req.message, req.expectedHead]);
    } catch {
      await git(tmp, ["merge", "--abort"]).catch(() => undefined);
      return { ok: false, reason: "conflict", message: "the branch does not merge cleanly" };
    }
    const mergeSha = (await git(tmp, ["rev-parse", "HEAD"])).trim();

    const checkout = await checkedOutAt(req.cwd, req.baseRef);
    try {
      if (checkout) await git(checkout, ["merge", "--ff-only", mergeSha]);
      else await git(req.cwd, ["update-ref", `refs/heads/${req.baseRef}`, mergeSha, base]);
    } catch {
      return { ok: false, reason: "base-moved", message: `${req.baseRef} changed during the merge; nothing was merged` };
    }
    return { ok: true, mergeSha, alreadyMerged: false };
  } catch (err) {
    return { ok: false, reason: "error", message: err instanceof Error ? err.message.split("\n")[0]! : "merge failed" };
  } finally {
    await git(req.cwd, ["worktree", "remove", "--force", tmp]).catch(() => undefined);
    await rm(tmp, { recursive: true, force: true });
  }
}

/** "3 files changed, 20 insertions(+), 4 deletions(-)" for base...head. */
export async function shortStat(cwd: string, baseRef: string, head: string): Promise<string> {
  try {
    return (await git(cwd, ["diff", "--shortstat", `${baseRef}...${head}`])).trim() || "no changes";
  } catch {
    return "changes unknown";
  }
}

export async function isClean(cwd: string): Promise<boolean> {
  try {
    return (await git(cwd, ["status", "--porcelain"])).trim() === "";
  } catch {
    return false;
  }
}

export { revParse };
