import { symlinkSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runChecksGate } from "../src/checks.js";
import { sandboxRunner, sandboxSshArgs, worktreeFiles } from "../src/checksandbox.js";
import type { ChecksSettings, SandboxLogin } from "../src/config.js";
import { installFakeSsh } from "./fakessh.js";
import { makeRepoWithWorktree, sh, write } from "./helpers.js";

const login: SandboxLogin = {
  host: "127.0.0.1",
  port: 2299,
  knownHosts: "[127.0.0.1]:2299 ssh-ed25519 AAAAtest",
  username: "vt-a-0123456789",
  privateKey: { type: "secret_ref", secretId: "sec-key" },
};
const settings: ChecksSettings = { testCommand: null, lintCommand: null, maxDiffLines: 400, timeoutSeconds: 30, sandbox: null };

describe("sandboxSshArgs", () => {
  it("logs in with only the given key, checks the host key, and ignores any ssh config", () => {
    const args = sandboxSshArgs(login, "/tmp/k", "/tmp/kh");
    expect(args).toEqual(expect.arrayContaining(["-F", "/dev/null", "-i", "/tmp/k", "-p", "2299", "-l", "vt-a-0123456789"]));
    expect(args).toContain("StrictHostKeyChecking=yes");
    expect(args).toContain("BatchMode=yes");
    expect(args).toContain("UserKnownHostsFile=/tmp/kh");
    // the host comes after "--", so it can never be read as an option
    expect(args.slice(-2)).toEqual(["--", "127.0.0.1"]);
  });
});

describe("worktreeFiles", () => {
  it("lists tracked and new files, never .git, ignored or deleted files", () => {
    const { worktree } = makeRepoWithWorktree();
    write(worktree, ".gitignore", "node_modules/\n");
    write(worktree, "node_modules/x.js", "x\n");
    write(worktree, "src/new.ts", "export {};\n");
    sh(worktree, "rm", "-q", "README.md");
    return worktreeFiles(worktree).then((files) => {
      expect(files.sort()).toEqual([".gitignore", "src/new.ts"]);
    });
  });
});

describe("sandboxRunner (fake ssh, real vt-check-runner)", () => {
  let fake: ReturnType<typeof installFakeSsh>;
  beforeEach(() => {
    fake = installFakeSsh();
  });
  afterEach(() => fake.restore());

  it("runs the command on a copy of the worktree, as the owner's agent user", async () => {
    const { worktree } = makeRepoWithWorktree();
    write(worktree, "src/a.ts", "export const a = 1;\n");
    const report = await runChecksGate(worktree, "main", { ...settings, testCommand: "test -f src/a.ts && test -f README.md && test ! -e .git" }, sandboxRunner(worktree, login, "PRIVATE KEY"));
    expect(report.results.find((r) => r.name === "tests")).toMatchObject({ status: "passed" });
    expect(fake.args()).toEqual(expect.arrayContaining(["-l", "vt-a-0123456789"]));
    // the request is "<seconds> <command>"; the key file is gone afterwards
    expect(fake.args().at(-1)).toBe("30 test -f src/a.ts && test -f README.md && test ! -e .git");
  });

  it("reports failures and time-outs from the sandbox", async () => {
    const { worktree } = makeRepoWithWorktree();
    const runner = sandboxRunner(worktree, login, "k");
    expect(await runner("echo broken; exit 3", 30)).toMatchObject({ exitCode: 3, timedOut: false });
    expect((await runner("echo broken; exit 3", 30)).output).toContain("broken");
    expect(await runner("sleep 10", 1)).toMatchObject({ timedOut: true });
  });

  it("copies a symlink as a link: what it points to never leaves the host", async () => {
    const { worktree } = makeRepoWithWorktree();
    symlinkSync("/etc/hostname", `${worktree}/leak`);
    const out = await sandboxRunner(worktree, login, "k")("test -L leak && readlink leak", 30);
    expect(out).toMatchObject({ exitCode: 0 });
    expect(out.output.trim()).toBe("/etc/hostname");
  });

  it("gives the command a clean environment (no Paperclip tokens or keys)", async () => {
    const { worktree } = makeRepoWithWorktree();
    process.env.PAPERCLIP_API_KEY = "should-not-pass";
    try {
      const out = await sandboxRunner(worktree, login, "k")("env | cut -d= -f1 | sort | tr '\\n' ' '", 30);
      expect(out.output.trim().split(" ").sort()).toEqual(["CI", "HOME", "LANG", "PATH", "PWD", "TMPDIR"]);
    } finally {
      delete process.env.PAPERCLIP_API_KEY;
    }
  });
});
