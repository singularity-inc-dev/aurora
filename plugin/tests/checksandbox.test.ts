import { symlinkSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runChecksGate } from "../src/checks.js";
import { sandboxRunner, sandboxSshArgs } from "../src/checksandbox.js";
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

describe("sandboxRunner (fake ssh, real vt-check-runner)", () => {
  let fake: ReturnType<typeof installFakeSsh>;
  beforeEach(() => {
    fake = installFakeSsh();
  });
  afterEach(() => fake.restore());

  it("runs the command on the committed files only, as the owner's agent user", async () => {
    const { worktree } = makeRepoWithWorktree();
    write(worktree, "src/a.ts", "export const a = 1;\n");
    sh(worktree, "add", "-A");
    sh(worktree, "commit", "-q", "-m", "a");
    write(worktree, "src/untracked.ts", "export {};\n");
    const only = await sandboxRunner(worktree, login, "k")("test -f src/a.ts && test ! -e src/untracked.ts", 30, sh(worktree, "rev-parse", "HEAD").trim());
    expect(only).toMatchObject({ exitCode: 0 });
    const report = await runChecksGate(worktree, "main", { ...settings, testCommand: "test -f src/a.ts && test -f README.md && test ! -e .git" }, sandboxRunner(worktree, login, "PRIVATE KEY"));
    expect(report.results.find((r) => r.name === "tests")).toMatchObject({ status: "passed" });
    expect(fake.args()).toEqual(expect.arrayContaining(["-l", "vt-a-0123456789"]));
    // the request is "<seconds> <command>"; the key file is gone afterwards
    expect(fake.args().at(-1)).toBe("30 test -f src/a.ts && test -f README.md && test ! -e .git");
  });

  it("reports failures and time-outs from the sandbox", async () => {
    const { worktree } = makeRepoWithWorktree();
    const runner = sandboxRunner(worktree, login, "k");
    const head = sh(worktree, "rev-parse", "HEAD").trim();
    expect(await runner("echo broken; exit 3", 30, head)).toMatchObject({ exitCode: 3, timedOut: false });
    expect((await runner("echo broken; exit 3", 30, head)).output).toContain("broken");
    expect(await runner("sleep 10", 1, head)).toMatchObject({ timedOut: true });
    expect(await runner("true", 30, "HEAD; rm -rf /")).toMatchObject({ exitCode: null });
  });

  it("copies a committed symlink as a link: what it points to never leaves the host", async () => {
    const { worktree } = makeRepoWithWorktree();
    symlinkSync("/etc/hostname", `${worktree}/leak`);
    sh(worktree, "add", "-A");
    sh(worktree, "commit", "-q", "-m", "link");
    const out = await sandboxRunner(worktree, login, "k")("test -L leak && readlink leak", 30, sh(worktree, "rev-parse", "HEAD").trim());
    expect(out).toMatchObject({ exitCode: 0 });
    expect(out.output.trim()).toBe("/etc/hostname");
  });

  it("gives the command a clean environment (no Paperclip tokens or keys)", async () => {
    const { worktree } = makeRepoWithWorktree();
    process.env.PAPERCLIP_API_KEY = "should-not-pass";
    try {
      const out = await sandboxRunner(worktree, login, "k")("env | cut -d= -f1 | sort | tr '\\n' ' '", 30, sh(worktree, "rev-parse", "HEAD").trim());
      expect(out.output.trim().split(" ").sort()).toEqual(["CI", "HOME", "LANG", "PATH", "PWD", "TMPDIR"]);
    } finally {
      delete process.env.PAPERCLIP_API_KEY;
    }
  });
});
