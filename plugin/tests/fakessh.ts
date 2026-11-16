import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const RUNNER = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../deploy/bin/vt-check-runner");

/**
 * A stand-in `ssh` on PATH: it records its arguments and hands the request to the
 * real deploy/bin/vt-check-runner the way sshd's forced command would (the remote
 * command in SSH_ORIGINAL_COMMAND, the tar on standard input). No SSH server, no
 * other user: the live test (scripts/it/v1a.sh) covers those.
 */
export function installFakeSsh(): { bin: string; args: () => string[]; restore: () => void } {
  const bin = mkdtempSync(path.join(tmpdir(), "vt-fakessh-"));
  const log = path.join(bin, "args");
  writeFileSync(
    path.join(bin, "ssh"),
    `#!/bin/sh\nfor a in "$@"; do printf '%s\\n' "$a"; done >${JSON.stringify(log)}\nfor last in "$@"; do :; done\nSSH_ORIGINAL_COMMAND="$last" exec ${JSON.stringify(RUNNER)}\n`,
  );
  chmodSync(path.join(bin, "ssh"), 0o755);
  const before = process.env.PATH;
  process.env.PATH = `${bin}:${before ?? ""}`;
  return {
    bin,
    args: () => readFileSync(log, "utf8").split("\n").filter(Boolean),
    restore: () => {
      process.env.PATH = before;
    },
  };
}
