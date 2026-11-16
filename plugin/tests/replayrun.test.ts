import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { assertNotRoot, parseTasksFile, ReplayRefused, runReplay, selectTasks, TASKS_FORMAT, type ReplayOptions } from "../src/replayrun.js";
import { compare } from "../src/replayeval.js";
import type { ReplayTask } from "../src/replaysave.js";
import { sh, write } from "./helpers.js";

const GATE = { testCommand: "test -f done.txt", lintCommand: null, maxDiffLines: 50, timeoutSeconds: 20 };

/** A project repo with `n` commits; each saved task starts at its own commit. */
function project(n: number) {
  const root = mkdtempSync(path.join(tmpdir(), "vt-rr-"));
  const repo = path.join(root, "project");
  write(repo, "README.md", "hi\n");
  sh(root, "init", "-q", "-b", "main", repo);
  sh(repo, "config", "user.email", "t@example.com");
  sh(repo, "config", "user.name", "T");
  const shas: string[] = [];
  for (let i = 0; i < n; i += 1) {
    write(repo, `f${i}.txt`, `${i}\n`);
    sh(repo, "add", ".");
    sh(repo, "commit", "-q", "-m", `c${i}`);
    shas.push(sh(repo, "rev-parse", "HEAD").trim());
  }
  return { root, repo, shas };
}

function task(i: number, baseSha: string, extra: Partial<ReplayTask> = {}): ReplayTask {
  return { taskId: `t${i}`, identifier: `VT-${i}`, owner: "o-1", taskKind: "task", title: `Task ${i}`, description: `Do ${i}`, inputsRedacted: false, descriptionTruncated: false, baseRef: "main", baseSha, headSha: baseSha, checksResult: "passed", outcome: "accepted", rejectReason: null, startedAt: null, finishedAt: null, durationSeconds: null, ...extra };
}

/** Fake agent: behaviour depends on the prompt file. "COMMIT" -> writes done.txt and commits. "FORGET" -> writes it, never commits. "SLOW" -> sleeps. "CRASH" -> exits 3. */
function fakeAgent(dir: string): string {
  const file = path.join(dir, "agent.sh");
  writeFileSync(
    file,
    `#!/bin/sh
p=$(cat "$VT_REPLAY_PROMPT_FILE")
case "$p" in
  *COMMIT*) echo "$(head -1 "$VT_REPLAY_TASK_FILE")" > done.txt; git add done.txt; git commit -q -m work ;;
  *FORGET*) echo x > done.txt ;;
  *SLOW*) sleep 30 ;;
  *CRASH*) echo "boom: something broke" >&2; exit 3 ;;
  *PROBE*) { env | cut -d= -f1 | sort | tr '\\n' ' '; echo; git remote | wc -l; git push origin HEAD 2>&1 | head -1; } > probe.txt; git add probe.txt; git commit -q -m probe; echo ok > done.txt; git add done.txt; git commit -q -m work ;;
esac
exit 0
`,
  );
  chmodSync(file, 0o755);
  return file;
}

function prompts(dir: string, base: string, cand: string) {
  const b = path.join(dir, "base.md");
  const c = path.join(dir, "cand.md");
  writeFileSync(b, base);
  writeFileSync(c, cand);
  return { b, c };
}

function opts(repo: string, dir: string, base: string, cand: string, extra: Partial<ReplayOptions> = {}): ReplayOptions {
  const { b, c } = prompts(dir, base, cand);
  return { repo, baselinePrompt: b, candidatePrompt: c, agentCommand: fakeAgent(dir), agentTimeoutSeconds: 20, repeats: 1, limit: 20, checks: GATE, passEnv: [], commitLeftovers: false, allowFewer: true, keep: false, workDir: path.join(dir, "work"), ...extra };
}

describe("replaying saved tasks", () => {
  it("scores each prompt by the real checks gate and finds the better one", async () => {
    const p = project(3);
    const tasks = p.shas.map((s, i) => task(i, s));
    const out = await runReplay(tasks, opts(p.repo, p.root, "please FORGET to commit", "please COMMIT"));
    expect(out.runs).toHaveLength(6);
    const verdicts = (arm: string) => out.runs.filter((r) => r.arm === arm).map((r) => r.verdict);
    expect(verdicts("baseline")).toEqual(["no-changes", "no-changes", "no-changes"]);
    expect(verdicts("candidate")).toEqual(["passed", "passed", "passed"]);
    expect(compare(out.runs).candidateOnly).toHaveLength(3);
    expect(out.runs.every((r) => r.agentSeconds !== null)).toBe(true);
  });

  it("reports NOT TESTED when no test command is set up, never passed", async () => {
    const p = project(1);
    const out = await runReplay([task(0, p.shas[0]!)], opts(p.repo, p.root, "COMMIT", "COMMIT", { checks: { ...GATE, testCommand: null } }));
    expect(out.runs.map((r) => r.verdict)).toEqual(["not-tested", "not-tested"]);
  });

  it("fails a run whose tests fail, and names the check", async () => {
    const p = project(1);
    const out = await runReplay([task(0, p.shas[0]!)], opts(p.repo, p.root, "COMMIT", "COMMIT", { checks: { ...GATE, testCommand: "false" } }));
    expect(out.runs[0]).toMatchObject({ verdict: "failed", failedChecks: ["tests"] });
    expect(out.runs[0]!.detail).toContain("exit code 1");
  });

  it("stops an agent that runs too long and counts it as an agent error", async () => {
    const p = project(1);
    const out = await runReplay([task(0, p.shas[0]!)], opts(p.repo, p.root, "SLOW", "COMMIT", { agentTimeoutSeconds: 1 }));
    const slow = out.runs.find((r) => r.arm === "baseline")!;
    expect(slow.verdict).toBe("agent-error");
    expect(slow.detail).toContain("did not finish within 1s");
    expect(slow.checkSeconds).toBeNull();
    expect(out.runs.find((r) => r.arm === "candidate")!.verdict).toBe("passed");
  });

  it("explains a crashed agent with its last line, and still checks what it left", async () => {
    const p = project(1);
    const out = await runReplay([task(0, p.shas[0]!)], opts(p.repo, p.root, "CRASH", "COMMIT"));
    const r = out.runs.find((x) => x.arm === "baseline")!;
    expect(r.verdict).toBe("no-changes");
    expect(r.detail).toContain("exited with code 3");
    expect(r.detail).toContain("boom: something broke");
  });

  it("an agent that cannot start is an agent error", async () => {
    const p = project(1);
    const out = await runReplay([task(0, p.shas[0]!)], opts(p.repo, p.root, "COMMIT", "COMMIT", { agentCommand: "/nonexistent/agent" }));
    expect(out.runs.every((r) => r.verdict === "no-changes" || r.verdict === "agent-error")).toBe(true);
  });

  it("with --commit-leftovers, uncommitted work counts; without it, it does not", async () => {
    const p = project(1);
    const t = [task(0, p.shas[0]!)];
    expect((await runReplay(t, opts(p.repo, p.root, "FORGET", "FORGET"))).runs[0]!.verdict).toBe("no-changes");
    expect((await runReplay(t, opts(p.repo, p.root, "FORGET", "FORGET", { commitLeftovers: true }))).runs[0]!.verdict).toBe("passed");
  });

  it("gives the agent the task text and a minimal environment, and no way to push", async () => {
    process.env.VT_CANARY_SECRET = "canary-value-123";
    process.env.VT_ALLOWED = "yes";
    try {
      const p = project(1);
      const out = await runReplay([task(0, p.shas[0]!, { title: "Hello title" })], opts(p.repo, p.root, "PROBE", "PROBE", { keep: true, passEnv: ["VT_ALLOWED"] }));
      expect(out.runs.every((r) => r.verdict === "passed")).toBe(true);
      const kept = readdirSync(path.join(p.root, "work"));
      const probe = readFileSync(path.join(p.root, "work", kept[0]!, "work", "probe.txt"), "utf8");
      expect(probe).not.toContain("VT_CANARY_SECRET");
      expect(probe).toContain("VT_ALLOWED");
      expect(probe).toContain("VT_REPLAY_TASK_FILE");
      expect(probe.split("\n")[1]).toBe("0"); // no git remotes
      expect(probe).toMatch(/fatal|does not appear|No configured push/i);
      // The real project is untouched: no new branches, no worktrees.
      expect(sh(p.repo, "branch", "--list").trim()).toBe("* main");
    } finally {
      delete process.env.VT_CANARY_SECRET;
      delete process.env.VT_ALLOWED;
    }
  });

  it("cleans up its folders unless asked to keep them", async () => {
    const p = project(1);
    await runReplay([task(0, p.shas[0]!)], opts(p.repo, p.root, "COMMIT", "COMMIT"));
    expect(readdirSync(path.join(p.root, "work"))).toEqual([]);
  });

  it("alternates which prompt goes first and repeats runs", async () => {
    const p = project(2);
    const log: string[] = [];
    const out = await runReplay(p.shas.map((s, i) => task(i, s)), opts(p.repo, p.root, "COMMIT", "COMMIT", { repeats: 2, log: (l) => log.push(l) }));
    expect(out.runs).toHaveLength(8);
    expect(log[0]).toContain("VT-0 baseline");
    expect(log.find((l) => l.includes("VT-1")) ?? "").toContain("VT-1 candidate");
    expect(Math.max(...out.runs.map((r) => r.repeat))).toBe(2);
  });

  it("skips tasks it cannot replay, with a reason, and replays the rest", async () => {
    const p = project(1);
    const tasks = [task(0, p.shas[0]!), task(1, "f".repeat(40)), task(2, p.shas[0]!, { descriptionTruncated: true }), task(3, "nonsense"), task(0, p.shas[0]!)];
    const out = await runReplay(tasks, opts(p.repo, p.root, "COMMIT", "COMMIT"));
    expect(out.labels.map((l) => l.taskId)).toEqual(["t0"]);
    expect(out.skipped.map((s) => s.reason)).toEqual([
      expect.stringContaining("not in this repository"),
      expect.stringContaining("cut short"),
      expect.stringContaining("not a full commit id"),
      expect.stringContaining("listed twice"),
    ]);
  });

  it("caps at 20 tasks and refuses fewer than 10 unless allowed", async () => {
    const p = project(1);
    const many = Array.from({ length: 25 }, (_, i) => task(i, p.shas[0]!));
    const sel = await selectTasks(many, p.repo);
    expect(sel.usable).toHaveLength(25);
    await expect(runReplay(many.slice(0, 3), opts(p.repo, p.root, "COMMIT", "COMMIT", { allowFewer: false }))).rejects.toThrow(/needs 10 to 20/);
    await expect(runReplay([task(0, "e".repeat(40))], opts(p.repo, p.root, "COMMIT", "COMMIT"))).rejects.toThrow(ReplayRefused);
  });

  it("rejects a missing repository and bad environment variable names", async () => {
    const p = project(1);
    await expect(runReplay([task(0, p.shas[0]!)], opts("/no/such/folder", p.root, "a", "b"))).rejects.toThrow(/does not exist/);
    await expect(runReplay([task(0, p.shas[0]!)], opts(p.repo, p.root, "a", "b", { passEnv: ["BAD NAME;rm"] }))).rejects.toThrow(/not a valid environment/);
  });

  it("never records agent output beyond one redacted line", async () => {
    const p = project(1);
    const out = await runReplay([task(0, p.shas[0]!)], opts(p.repo, p.root, "CRASH", "CRASH"));
    expect(JSON.stringify(out.runs).length).toBeLessThan(2000);
    expect(existsSync(path.join(p.root, "work", "task.md"))).toBe(false);
  });
});

describe("safety and file checks", () => {
  it("refuses to run as root unless told to", () => {
    expect(() => assertNotRoot(0, false)).toThrow(/root/);
    expect(() => assertNotRoot(0, true)).not.toThrow();
    expect(() => assertNotRoot(1000, false)).not.toThrow();
    expect(() => assertNotRoot(undefined, false)).not.toThrow();
  });

  it("reads a tasks file, with the gate settings, and rejects garbage in plain words", () => {
    const good = JSON.stringify({ format: TASKS_FORMAT, tasks: [task(0, "a".repeat(40))], checks: { testCommand: "pnpm test", lintCommand: "", maxDiffLines: 99, timeoutSeconds: 5 } });
    const r = parseTasksFile(good);
    expect(r.ok && r.file.tasks[0]!.taskId).toBe("t0");
    expect(r.ok && r.file.checks).toEqual({ testCommand: "pnpm test", lintCommand: null, maxDiffLines: 99, timeoutSeconds: 5 });
    expect(parseTasksFile("{nope")).toEqual({ ok: false, errors: ["the tasks file is not valid JSON"] });
    expect(parseTasksFile('{"format":"other"}')).toMatchObject({ ok: false });
    expect(parseTasksFile(JSON.stringify({ format: TASKS_FORMAT, tasks: [{ taskId: 1 }] }))).toMatchObject({ ok: false });
    expect(parseTasksFile(JSON.stringify({ format: TASKS_FORMAT, tasks: [] }))).toMatchObject({ ok: true });
  });
});
