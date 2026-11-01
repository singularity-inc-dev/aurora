/**
 * vt-replay run: rerun saved tasks with a baseline and a candidate prompt.
 * Built to dist/replay-cli.js. See docs/REPLAY.md.
 */
import { readFile, writeFile } from "node:fs/promises";
import { MAX_TASKS, MIN_TASKS, renderReport } from "./replayeval.js";
import { assertNotRoot, parseTasksFile, ReplayRefused, runReplay, type GateSettings } from "./replayrun.js";

export const USAGE = `Usage: vt-replay run --tasks FILE --repo DIR --baseline FILE --candidate FILE --agent-cmd 'COMMAND' [options]

  --tasks FILE        saved tasks (written by: vt-replay save)
  --repo DIR          a clone of the project; it is only read
  --baseline FILE     the current prompt (a text file)
  --candidate FILE    the new prompt (a text file)
  --agent-cmd CMD     runs the agent in the task's folder. It sees VT_REPLAY_PROMPT_FILE
                      (the prompt) and VT_REPLAY_TASK_FILE (the ticket text)
Options:
  --limit N           tasks to replay, at most ${MAX_TASKS} (default ${MAX_TASKS})
  --repeats N         runs per task and prompt (default 1; 3 is steadier)
  --agent-timeout S   seconds before an agent is stopped (default 900)
  --checks-config F   JSON {testCommand, lintCommand, maxDiffLines, timeoutSeconds}; default: the file's own
  --pass-env A,B      environment variables to hand to the agent (default: none)
  --commit-leftovers  commit what the agent left uncommitted (the product only checks commits)
  --allow-fewer       run with fewer than ${MIN_TASKS} tasks (the report will warn)
  --allow-root        allow running as root (throwaway machines only)
  --out FILE          write the report here (default: print it)
  --json FILE         also write every run as JSON
  --keep              keep the throwaway folders
`;

interface Parsed {
  tasks: string;
  repo: string;
  baseline: string;
  candidate: string;
  agentCmd: string;
  limit: number;
  repeats: number;
  agentTimeout: number;
  checksConfig: string | null;
  passEnv: string[];
  commitLeftovers: boolean;
  allowFewer: boolean;
  allowRoot: boolean;
  out: string | null;
  json: string | null;
  keep: boolean;
}

export function parseArgs(argv: string[]): { ok: true; args: Parsed } | { ok: false; error: string } {
  const values: Record<string, string> = {};
  const flags = new Set<string>();
  const valued = new Set(["tasks", "repo", "baseline", "candidate", "agent-cmd", "limit", "repeats", "agent-timeout", "checks-config", "pass-env", "out", "json"]);
  const boolean = new Set(["commit-leftovers", "allow-fewer", "allow-root", "keep"]);
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]!;
    if (!a.startsWith("--")) return { ok: false, error: `unexpected argument "${a}"` };
    const name = a.slice(2);
    if (boolean.has(name)) flags.add(name);
    else if (valued.has(name)) {
      const v = argv[i + 1];
      if (v === undefined) return { ok: false, error: `--${name} needs a value` };
      values[name] = v;
      i += 1;
    } else return { ok: false, error: `unknown option --${name}` };
  }
  for (const req of ["tasks", "repo", "baseline", "candidate", "agent-cmd"]) if (!values[req]) return { ok: false, error: `--${req} is required` };
  const num = (name: string, def: number, min: number, max: number): number | null => {
    if (values[name] === undefined) return def;
    const n = Number(values[name]);
    return Number.isInteger(n) && n >= min && n <= max ? n : null;
  };
  const limit = num("limit", MAX_TASKS, 1, MAX_TASKS);
  const repeats = num("repeats", 1, 1, 10);
  const agentTimeout = num("agent-timeout", 900, 1, 86_400);
  if (limit === null) return { ok: false, error: `--limit must be a whole number from 1 to ${MAX_TASKS}` };
  if (repeats === null) return { ok: false, error: "--repeats must be a whole number from 1 to 10" };
  if (agentTimeout === null) return { ok: false, error: "--agent-timeout must be a whole number of seconds" };
  return {
    ok: true,
    args: {
      tasks: values.tasks!, repo: values.repo!, baseline: values.baseline!, candidate: values.candidate!, agentCmd: values["agent-cmd"]!,
      limit, repeats, agentTimeout, checksConfig: values["checks-config"] ?? null,
      passEnv: (values["pass-env"] ?? "").split(",").map((s) => s.trim()).filter(Boolean),
      commitLeftovers: flags.has("commit-leftovers"), allowFewer: flags.has("allow-fewer"), allowRoot: flags.has("allow-root"),
      out: values.out ?? null, json: values.json ?? null, keep: flags.has("keep"),
    },
  };
}

export interface Io {
  uid: number | undefined;
  out: (text: string) => void;
  err: (text: string) => void;
  now: () => Date;
}

const describeGate = (g: GateSettings) =>
  `tests ${g.testCommand ? `\`${g.testCommand}\`` : "(none: results are NOT TESTED)"}, lint ${g.lintCommand ? `\`${g.lintCommand}\`` : "(none)"}, diff limit ${g.maxDiffLines} lines`;

/** Returns the exit code: 0 done, 2 bad usage or input, 3 refused to run. */
export async function main(argv: string[], io: Io): Promise<number> {
  if (argv[0] !== "run" || argv.includes("--help")) {
    io.err(USAGE);
    return argv.includes("--help") ? 0 : 2;
  }
  const parsed = parseArgs(argv.slice(1));
  if (!parsed.ok) {
    io.err(`${parsed.error}\n\n${USAGE}`);
    return 2;
  }
  const a = parsed.args;
  try {
    assertNotRoot(io.uid, a.allowRoot);
    const file = parseTasksFile(await readFile(a.tasks, "utf8").catch(() => "")); // unreadable -> the "not valid JSON" message
    if (!file.ok) {
      io.err(file.errors.join("\n"));
      return 2;
    }
    let checks: GateSettings | null = file.file.checks;
    if (a.checksConfig) {
      try {
        const c = JSON.parse(await readFile(a.checksConfig, "utf8")) as Partial<GateSettings>;
        checks = { testCommand: c.testCommand || null, lintCommand: c.lintCommand || null, maxDiffLines: c.maxDiffLines ?? 400, timeoutSeconds: c.timeoutSeconds ?? 300 };
      } catch {
        io.err("could not read --checks-config as JSON");
        return 2;
      }
    }
    if (!checks) {
      io.err("the tasks file has no checks settings; pass --checks-config");
      return 2;
    }
    for (const f of [a.baseline, a.candidate]) {
      if (!(await readFile(f, "utf8").then(() => true, () => false))) {
        io.err(`cannot read the prompt file ${f}`);
        return 2;
      }
    }
    const outcome = await runReplay(file.file.tasks, {
      repo: a.repo, baselinePrompt: a.baseline, candidatePrompt: a.candidate, agentCommand: a.agentCmd,
      agentTimeoutSeconds: a.agentTimeout, repeats: a.repeats, limit: a.limit, checks, passEnv: a.passEnv,
      commitLeftovers: a.commitLeftovers, allowFewer: a.allowFewer, keep: a.keep, log: (l) => io.err(l),
    });
    const report = renderReport({ ...outcome, baselineName: a.baseline, candidateName: a.candidate, gate: describeGate(checks), generatedAt: io.now() });
    if (a.out) await writeFile(a.out, report, { mode: 0o600 });
    else io.out(report);
    if (a.json) await writeFile(a.json, JSON.stringify({ runs: outcome.runs, skipped: outcome.skipped }, null, 2), { mode: 0o600 });
    if (a.out) io.err(`Report written to ${a.out}.`);
    return 0;
  } catch (err) {
    if (err instanceof ReplayRefused) {
      io.err(err.message);
      return 3;
    }
    throw err;
  }
}
