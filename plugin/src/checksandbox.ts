import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { SandboxLogin } from "./config.js";
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

/**
 * Run check commands as the task owner's own agent user: the files of the
 * checked commit (`git archive`, committed files only, never the working folder)
 * go over ssh as a tar stream, deploy/bin/vt-check-runner unpacks it into a
 * fresh folder, runs the command with a clean environment and deletes the folder.
 * The command never runs as Paperclip's own user (code an agent wrote cannot read
 * Paperclip's data or secrets) nor as another owner's.
 */
export function sandboxRunner(cwd: string, sb: SandboxLogin, privateKey: string): CommandRunner {
  return async (command, timeoutSeconds, commit) => {
    if (!/^[0-9a-f]{40}([0-9a-f]{24})?$/.test(commit)) return { exitCode: null, timedOut: false, output: "not a commit id" };
    const dir = await mkdtemp(path.join(tmpdir(), "vt-sandbox-"));
    try {
      const keyFile = path.join(dir, "key");
      const knownHostsFile = path.join(dir, "known_hosts");
      await writeFile(keyFile, privateKey.endsWith("\n") ? privateKey : `${privateKey}\n`, { mode: 0o600 });
      await writeFile(knownHostsFile, `${sb.knownHosts}\n`, { mode: 0o600 });
      return await runOverSsh(cwd, commit, sandboxSshArgs(sb, keyFile, knownHostsFile), `${timeoutSeconds} ${command}`, timeoutSeconds);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  };
}

function runOverSsh(cwd: string, commit: string, sshArgs: string[], remote: string, timeoutSeconds: number): Promise<CommandOutcome> {
  return new Promise((resolve) => {
    const env = { PATH: process.env.PATH ?? "", LANG: "C.UTF-8" };
    const tar = spawn("git", ["archive", "--format=tar", commit], { cwd, env, stdio: ["ignore", "pipe", "ignore"] });
    const ssh = spawn("ssh", [...sshArgs, remote], { env, stdio: ["pipe", "pipe", "pipe"] });
    let output = "";
    const collect = (chunk: Buffer) => {
      output = (output + chunk.toString("utf8")).slice(-OUTPUT_TAIL_CHARS * 4);
    };
    ssh.stdout.on("data", collect);
    ssh.stderr.on("data", collect);
    tar.stdout.pipe(ssh.stdin);
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
