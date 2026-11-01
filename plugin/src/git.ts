import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { AddedLine } from "./secretscan.js";

const run = promisify(execFile);

/** Run git without a shell, so no argument can be interpreted as a command. */
export async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await run("git", args, { cwd, maxBuffer: 64 * 1024 * 1024, env: { PATH: process.env.PATH ?? "" } });
  return stdout;
}

export async function mergeBase(cwd: string, baseRef: string, head = "HEAD"): Promise<string> {
  return (await git(cwd, ["merge-base", baseRef, head])).trim();
}

export async function headSha(cwd: string): Promise<string> {
  return (await git(cwd, ["rev-parse", "HEAD"])).trim();
}

export interface DiffStats {
  files: string[];
  addedLines: number;
  removedLines: number;
}

/**
 * Committed changes from `base` to `head`. Uncommitted and untracked files never
 * count: the checks judge exactly the commit the owner would approve.
 */
export async function diffStats(cwd: string, base: string, head: string): Promise<DiffStats> {
  const files = new Set<string>();
  let added = 0;
  let removed = 0;
  for (const row of (await git(cwd, ["diff", "--numstat", base, head, "--"])).split("\n")) {
    const [a, r, file] = row.split("\t");
    if (!file) continue;
    files.add(file);
    if (a !== "-") added += Number(a);
    if (r !== "-") removed += Number(r);
  }
  return { files: [...files].sort(), addedLines: added, removedLines: removed };
}

/** Every file a commit range touches, by its exact path: a rename counts as both names, a deletion too. */
export async function changedFiles(cwd: string, base: string, head: string): Promise<string[]> {
  const out = await git(cwd, ["-c", "core.quotePath=false", "diff", "--name-only", "--no-renames", base, head, "--"]);
  return [...new Set(out.split("\n").filter(Boolean))].sort();
}

/** Every line added from `base` to `head` (committed only), with its new line number. */
export async function addedLines(cwd: string, base: string, head: string): Promise<AddedLine[]> {
  const result: AddedLine[] = [];
  let file = "";
  let lineNo = 0;
  for (const row of (await git(cwd, ["diff", "-U0", "--no-color", base, head, "--"])).split("\n")) {
    if (row.startsWith("+++ ")) {
      file = row.startsWith("+++ b/") ? row.slice(6) : "";
      continue;
    }
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(row);
    if (hunk) {
      lineNo = Number(hunk[1]);
      continue;
    }
    if (row.startsWith("+") && file) {
      result.push({ file, line: lineNo, text: row.slice(1) });
      lineNo += 1;
    }
  }
  return result;
}
