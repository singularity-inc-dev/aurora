import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { replayMerge, replayPairs, type ReadyBranch } from "../src/replay.js";

const dir = mkdtempSync(path.join(tmpdir(), "vt-replay-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const g = (...args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "pipe" }).toString().trim();
g("init", "-q", "-b", "main");
g("config", "user.email", "t@example.com");
g("config", "user.name", "t");
writeFileSync(path.join(dir, "shared.txt"), "one\ntwo\nthree\n");
writeFileSync(path.join(dir, "other.txt"), "x\n");
g("add", ".");
g("commit", "-qm", "base");

/** A branch from main that writes `content` to `file`; returns its head. */
function branch(name: string, file: string, content: string): string {
  g("checkout", "-q", "-b", name, "main");
  writeFileSync(path.join(dir, file), content);
  g("commit", "-qam", name);
  const head = g("rev-parse", "HEAD");
  g("checkout", "-q", "main");
  return head;
}
const anaShared = branch("ana-1", "shared.txt", "one\nANA\nthree\n");
const boShared = branch("bo-1", "shared.txt", "one\nBO\nthree\n");
const boOther = branch("bo-2", "other.txt", "y\n");
const ready = (taskId: string, owner: string, head: string): ReadyBranch => ({ taskId, owner, title: taskId, identifier: null, head, cwd: dir });

describe("merge replay", () => {
  it("finds the files two branches both change in different ways", async () => {
    expect(await replayMerge(dir, anaShared, boShared)).toEqual({ status: "conflict", files: ["shared.txt"] });
  });

  it("is clean when the branches change different files", async () => {
    expect(await replayMerge(dir, anaShared, boOther)).toEqual({ status: "clean" });
  });

  it("changes nothing: no branch, file or index moves", async () => {
    const before = [g("rev-parse", "main"), g("status", "--porcelain"), g("for-each-ref")];
    await replayMerge(dir, anaShared, boShared);
    expect([g("rev-parse", "main"), g("status", "--porcelain"), g("for-each-ref")]).toEqual(before);
  });

  it("refuses anything that is not a commit id, and reports git errors", async () => {
    expect(await replayMerge(dir, "--output=/tmp/x", boShared)).toEqual({ status: "error", message: "not a commit id" });
    expect((await replayMerge(dir, "0".repeat(40), boShared)).status).toBe("error");
  });

  it("replays mine against each other and against everyone else's, once per pair", async () => {
    const { conflicts, unreplayed } = await replayPairs([ready("A1", "ana", anaShared)], [ready("B1", "bo", boShared), ready("B2", "bo", boOther)]);
    expect(conflicts.map((c) => [c.a.taskId, c.b.taskId, c.files])).toEqual([["A1", "B1", ["shared.txt"]]]);
    expect(unreplayed).toEqual([]);
    const own = await replayPairs([ready("A1", "ana", anaShared), ready("A2", "ana", boShared)], []);
    expect(own.conflicts.map((c) => [c.a.taskId, c.b.taskId])).toEqual([["A1", "A2"]]);
  });

  it("lists pairs it could not replay instead of calling them clean", async () => {
    const { unreplayed } = await replayPairs([ready("A1", "ana", anaShared)], [ready("X", "cy", "f".repeat(40))]);
    expect(unreplayed.map(([a, b]) => [a.taskId, b.taskId])).toEqual([["A1", "X"]]);
  });
});
