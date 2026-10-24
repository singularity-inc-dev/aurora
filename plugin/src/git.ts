import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { AddedLine } from "./secretscan.js";

const run = promisify(execFile);

/** Run git without a shell, so no argument can be interpreted as a command. */
export async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await run("git", args, { cwd, maxBuffer: 64 * 1024 * 1024, env: { PATH: process.env.PATH ?? "" } });
  return stdout;
}

export async function mergeBase(cwd: string, baseRef: string): Promise<string> {
  return (await git(cwd, ["merge-base", baseRef, "HEAD"])).trim();
}

export async function headSha(cwd: string): Promise<string> {
  return (await git(cwd, ["rev-parse", "HEAD"])).trim();
}

export async function untrackedFiles(cwd: string): Promise<string[]> {
  const out = await git(cwd, ["ls-files", "--others", "--exclude-standard", "-z"]);
  return out.split("\0").filter(Boolean);
}

export interface DiffStats {
  files: string[];
  addedLines: number;
  removedLines: number;
}

/** Changes against `base`, including uncommitted and untracked files. */
export async function diffStats(cwd: string, base: string): Promise<DiffStats> {
  const files = new Set<string>();
  let added = 0;
  let removed = 0;
  for (const row of (await git(cwd, ["diff", "--numstat", base])).split("\n")) {
    const [a, r, file] = row.split("\t");
    if (!file) continue;
    files.add(file);
    if (a !== "-") added += Number(a);
    if (r !== "-") removed += Number(r);
  }
  for (const file of await untrackedFiles(cwd)) {
    files.add(file);
    const content = await readTextOrNull(path.join(cwd, file));
    if (content !== null) added += textLines(content).length;
  }
  return { files: [...files].sort(), addedLines: added, removedLines: removed };
}

/** Every added line against `base`, with its new line number. */
export async function addedLines(cwd: string, base: string): Promise<AddedLine[]> {
  const result: AddedLine[] = [];
  let file = "";
  let lineNo = 0;
  for (const row of (await git(cwd, ["diff", "-U0", "--no-color", base])).split("\n")) {
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
  for (const f of await untrackedFiles(cwd)) {
    const content = await readTextOrNull(path.join(cwd, f));
    if (content === null) continue;
    textLines(content).forEach((text, i) => result.push({ file: f, line: i + 1, text }));
  }
  return result;
}

/** Lines of a text file; a trailing newline does not start an extra line. */
export function textLines(content: string): string[] {
  if (content === "") return [];
  const lines = content.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

async function readTextOrNull(file: string): Promise<string | null> {
  const buf = await readFile(file).catch(() => null);
  if (!buf || buf.includes(0)) return null;
  return buf.toString("utf8");
}
