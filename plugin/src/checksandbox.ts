import { spawn } from "node:child_process";
import { lstat, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { SandboxLogin } from "./config.js";
import { git } from "./git.js";
import { redact } from "./secretscan.js";
import type { CommandOutcome, CommandRunner } from "./checks.js";

const OUTPUT_TAIL_CHARS = 4000;
/** Extra seconds for copying files and starting before the runner's own time limit kills the command. */
const GRACE_SECONDS = 30;
/** Exit code of the runner's `timeout` when the command ran out of time. */
const TIMEOUT_EXIT = 124;

/**
 * ssh arguments for the checks sandbox. No user ssh config (-F /dev/null), key
 * only, host key always checked. Every value was validated by parseSettings.
 */
export function sandboxSshArgs(sb: SandboxLogin, keyFile: string, knownHostsFile: string): string[] {
  return [
    "-F", "/dev/null",
    "-o", "BatchMode=yes",
    "-o", "IdentitiesOnly=yes",
    "-o", "StrictHostKeyChecking=yes",
    "-o", `UserKnownHostsFile=${knownHostsFile}`,
    "-o", "ConnectTimeout=10",
    "-i", keyFile,
    "-p", String(sb.port),
    "-l", sb.username,
    "--", sb.host,
  ];
}

/** Files of the worktree that go to the sandbox: tracked and untracked-but-not-ignored, never .git. */
export async function worktreeFiles(cwd: string): Promise<string[]> {
  const out = await git(cwd, ["ls-files", "-z", "--cached", "--others", "--exclude-standard"]);
  const files: string[] = [];
  for (const f of new Set(out.split("\0").filter(Boolean))) {
    if (f === ".git" || f.startsWith(".git/")) continue;
    // Deleted files are still listed by --cached; symlinks are copied as links (tar never follows them).
    if (await lstat(path.join(cwd, f)).then(() => true, () => false)) files.push(f);
  }
  return files;
}

/**
 * Run check commands as the task owner's own agent user: a copy of the worktree
 * goes over ssh as a tar stream, deploy/bin/vt-check-runner unpacks it into a
 * fresh folder, runs the command with a clean environment and deletes the folder.
 * The command never runs as Paperclip's own user (code an agent wrote cannot read
 * Paperclip's data or secrets) nor as another owner's.
 */
export function sandboxRunner(cwd: string, sb: SandboxLogin, privateKey: string): CommandRunner {
  return async (command, timeoutSeconds) => {
    const dir = await mkdtemp(path.join(tmpdir(), "vt-sandbox-"));
    try {
      const keyFile = path.join(dir, "key");
      const knownHostsFile = path.join(dir, "known_hosts");
      await writeFile(keyFile, privateKey.endsWith("\n") ? privateKey : `${privateKey}\n`, { mode: 0o600 });
      await writeFile(knownHostsFile, `${sb.knownHosts}\n`, { mode: 0o600 });
      const files = await worktreeFiles(cwd);
      return await runOverSsh(cwd, files, sandboxSshArgs(sb, keyFile, knownHostsFile), `${timeoutSeconds} ${command}`, timeoutSeconds);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  };
}

function runOverSsh(cwd: string, files: string[], sshArgs: string[], remote: string, timeoutSeconds: number): Promise<CommandOutcome> {
  return new Promise((resolve) => {
    const env = { PATH: process.env.PATH ?? "", LANG: "C.UTF-8" };
    const tar = spawn("tar", ["--null", "--no-recursion", "-T", "-", "-c", "-f", "-"], { cwd, env, stdio: ["pipe", "pipe", "ignore"] });
    const ssh = spawn("ssh", [...sshArgs, remote], { env, stdio: ["pipe", "pipe", "pipe"] });
    let output = "";
    const collect = (chunk: Buffer) => {
      output = (output + chunk.toString("utf8")).slice(-OUTPUT_TAIL_CHARS * 4);
    };
    ssh.stdout.on("data", collect);
    ssh.stderr.on("data", collect);
    tar.stdout.pipe(ssh.stdin);
    tar.stdin.end(files.map((f) => `${f}\0`).join(""));
    // A broken pipe (the sandbox refused or closed early) must not crash the worker.
    ssh.stdin.on("error", () => undefined);
    tar.stdout.on("error", () => undefined);
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      tar.kill("SIGKILL");
      ssh.kill("SIGKILL");
    }, (timeoutSeconds + GRACE_SECONDS) * 1000);
    let settled = false;
    const finish = (outcome: CommandOutcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(outcome);
    };
    ssh.on("close", (code) => {
      const tail = redact(output).slice(-OUTPUT_TAIL_CHARS);
      if (code === 255) finish({ exitCode: null, timedOut: false, output: `checks sandbox not reachable over ssh\n${tail}`.trim() });
      else finish({ exitCode: code, timedOut: timedOut || code === TIMEOUT_EXIT, output: tail });
    });
    ssh.on("error", () => finish({ exitCode: null, timedOut: false, output: "could not start ssh for the checks sandbox" }));
  });
}
