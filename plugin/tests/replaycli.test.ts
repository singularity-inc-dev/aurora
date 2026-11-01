import { chmodSync, existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { main, parseArgs, type Io } from "../src/replaycli.js";
import { TASKS_FORMAT } from "../src/replayrun.js";
import { sh, write } from "./helpers.js";

function io(uid = 1000) {
  const out: string[] = [];
  const err: string[] = [];
  const i: Io = { uid, out: (t) => out.push(t), err: (t) => err.push(t), now: () => new Date("2026-11-01T12:00:00Z") };
  return { i, out, err };
}

function bed(taskCount: number) {
  const root = mkdtempSync(path.join(tmpdir(), "vt-cli-"));
  const repo = path.join(root, "p");
  write(repo, "a.txt", "a\n");
  sh(root, "init", "-q", "-b", "main", repo);
  sh(repo, "config", "user.email", "t@example.com");
  sh(repo, "config", "user.name", "T");
  sh(repo, "add", ".");
  sh(repo, "commit", "-q", "-m", "init");
  const sha = sh(repo, "rev-parse", "HEAD").trim();
  const tasks = Array.from({ length: taskCount }, (_, i) => ({ taskId: `t${i}`, identifier: `VT-${i}`, owner: "o-1", taskKind: "task", title: `Task ${i}`, description: "d", inputsRedacted: false, descriptionTruncated: false, baseRef: "main", baseSha: sha, headSha: sha, checksResult: "passed", outcome: "accepted", rejectReason: null, startedAt: null, finishedAt: null, durationSeconds: null }));
  const tasksFile = path.join(root, "tasks.json");
  writeFileSync(tasksFile, JSON.stringify({ format: TASKS_FORMAT, tasks, checks: { testCommand: "test -f done.txt", lintCommand: null, maxDiffLines: 50, timeoutSeconds: 20 } }));
  const agent = path.join(root, "agent.sh");
  writeFileSync(agent, '#!/bin/sh\ncase "$(cat "$VT_REPLAY_PROMPT_FILE")" in *GOOD*) echo y > done.txt; git add .; git commit -q -m w;; esac\n');
  chmodSync(agent, 0o755);
  writeFileSync(path.join(root, "base.md"), "bad prompt");
  writeFileSync(path.join(root, "cand.md"), "GOOD prompt");
  const args = ["run", "--tasks", tasksFile, "--repo", repo, "--baseline", path.join(root, "base.md"), "--candidate", path.join(root, "cand.md"), "--agent-cmd", agent];
  return { root, args };
}

describe("vt-replay run: arguments", () => {
  it("needs the five required options and explains what is missing", () => {
    expect(parseArgs([])).toEqual({ ok: false, error: "--tasks is required" });
    expect(parseArgs(["--bogus", "x"])).toEqual({ ok: false, error: "unknown option --bogus" });
    expect(parseArgs(["--tasks"])).toEqual({ ok: false, error: "--tasks needs a value" });
    expect(parseArgs(["stray"])).toMatchObject({ ok: false });
  });
  it("keeps the task limit between 1 and 20, and repeats between 1 and 10", () => {
    const req = ["--tasks", "t", "--repo", "r", "--baseline", "b", "--candidate", "c", "--agent-cmd", "x"];
    expect(parseArgs([...req, "--limit", "21"])).toMatchObject({ ok: false });
    expect(parseArgs([...req, "--limit", "0"])).toMatchObject({ ok: false });
    expect(parseArgs([...req, "--repeats", "11"])).toMatchObject({ ok: false });
    expect(parseArgs([...req, "--agent-timeout", "abc"])).toMatchObject({ ok: false });
    const ok = parseArgs([...req, "--pass-env", "A, B", "--keep"]);
    expect(ok.ok && ok.args).toMatchObject({ limit: 20, repeats: 1, agentTimeout: 900, passEnv: ["A", "B"], keep: true });
  });
});

describe("vt-replay run: end to end", () => {
  it("writes a report that names the better prompt, 0600, and a JSON of every run", async () => {
    const b = bed(12);
    const { i, err } = io();
    const out = path.join(b.root, "report.md");
    const json = path.join(b.root, "runs.json");
    const code = await main([...b.args, "--out", out, "--json", json], i);
    expect(code).toBe(0);
    const report = readFileSync(out, "utf8");
    expect(report).toContain("The candidate is better");
    expect(report).toContain("Decided by tests only. No AI judge.");
    expect(report).toContain("tests `test -f done.txt`");
    expect(statSync(out).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(json, "utf8")).runs).toHaveLength(24);
    expect(err.join("")).toContain("[12/12] VT-11");
  });

  it("prints the report when no --out is given", async () => {
    const b = bed(10);
    const { i, out } = io();
    expect(await main(b.args, i)).toBe(0);
    expect(out.join("")).toContain("# Replay: baseline against candidate");
  });

  it("refuses to run as root, and with too few tasks, with exit code 3 and no report", async () => {
    const b = bed(3);
    const root = io(0);
    expect(await main(b.args, root.i)).toBe(3);
    expect(root.err.join("")).toContain("refusing to run as root");
    const few = io();
    expect(await main(b.args, few.i)).toBe(3);
    expect(few.err.join("")).toContain("needs 10 to 20");
    expect(few.out).toEqual([]);
    const allowed = io();
    expect(await main([...b.args, "--allow-fewer"], allowed.i)).toBe(0);
    expect(allowed.out.join("")).toContain("Only 3 tasks");
  });

  it("answers bad input with exit code 2 and a plain message", async () => {
    const b = bed(1);
    const garbage = path.join(b.root, "bad.json");
    writeFileSync(garbage, "nope");
    const args = [...b.args];
    args[args.indexOf("--tasks") + 1] = garbage;
    const r = io();
    expect(await main(args, r.i)).toBe(2);
    expect(r.err.join("")).toContain("not valid JSON");
    const missing = io();
    expect(await main(["run", "--tasks", "x"], missing.i)).toBe(2);
    expect(await main(["bogus"], io().i)).toBe(2);
    expect(await main(["run", "--help"], io().i)).toBe(0);
  });

  it("a missing prompt file is a usage error and leaves no report", async () => {
    const b = bed(1);
    const args = [...b.args];
    args[args.indexOf("--baseline") + 1] = path.join(b.root, "nope.md");
    const r = io();
    expect(await main(args, r.i)).toBe(2);
    expect(r.err.join("")).toContain("cannot read the prompt file");
    expect(existsSync(path.join(b.root, "report.md"))).toBe(false);
  });

  it("--checks-config overrides the gate in the tasks file", async () => {
    const b = bed(10);
    const cfg = path.join(b.root, "gate.json");
    writeFileSync(cfg, JSON.stringify({ testCommand: "false" }));
    const r = io();
    expect(await main([...b.args, "--checks-config", cfg], r.i)).toBe(0);
    expect(r.out.join("")).toContain("No task changed");
    expect(r.out.join("")).toContain("tests `false`");
  });
});
