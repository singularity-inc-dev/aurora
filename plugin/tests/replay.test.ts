import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { changedByBoth, replayMerge, replayPairs, type ReadyBranch } from "../src/replay.js";

const dir = mkdtempSync(path.join(tmpdir(), "vt-replay-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const g = (...args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "pipe" }).toString().trim();
g("init", "-q", "-b", "main");
g("config", "user.email", "t@example.com");
g("config", "user.name", "t");
writeFileSync(path.join(dir, "shared.txt"), "one\ntwo\nthree\n");
writeFileSync(path.join(dir, "other.txt"), "x\n");
const tenLines = Array.from({ length: 10 }, (_, i) => `line ${i + 1}`);
writeFileSync(path.join(dir, "long.txt"), `${tenLines.join("\n")}\n`);
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
// Same file, lines far apart: git merges these cleanly.
const anaTop = branch("ana-top", "long.txt", `${["ANA", ...tenLines.slice(1)].join("\n")}\n`);
const boBottom = branch("bo-bottom", "long.txt", `${[...tenLines.slice(0, 9), "BO"].join("\n")}\n`);
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

  it("lists files both branches change even when git merges them cleanly (the teammate check)", async () => {
    expect(await replayMerge(dir, anaTop, boBottom)).toEqual({ status: "clean" });
    expect(await changedByBoth(dir, anaTop, boBottom)).toEqual(["long.txt"]);
    expect(await changedByBoth(dir, anaTop, boOther)).toEqual([]);
    const r = await replayPairs([ready("A1", "ana", anaTop)], [ready("B1", "bo", boBottom), ready("B2", "bo", boOther), ready("B3", "bo", boShared)]);
    expect(r.conflicts).toEqual([]);
    // Only the pair that shares a file is listed; a pair with nothing in common is not.
    expect(r.shared.map((c) => [c.a.taskId, c.b.taskId, c.files])).toEqual([["A1", "B1", ["long.txt"]]]);
    // A conflicting pair is listed once, as a conflict, not also as shared.
    const both = await replayPairs([ready("A1", "ana", anaShared)], [ready("B1", "bo", boShared)]);
    expect([both.conflicts.length, both.shared.length]).toEqual([1, 0]);
  });

  it("the shared-files check changes nothing either", async () => {
    const before = [g("rev-parse", "main"), g("status", "--porcelain"), g("for-each-ref")];
    await changedByBoth(dir, anaTop, boBottom);
    expect([g("rev-parse", "main"), g("status", "--porcelain"), g("for-each-ref")]).toEqual(before);
    expect(await changedByBoth(dir, "--output=/tmp/x", boBottom)).toBeNull();
  });

  it("lists pairs it could not replay instead of calling them clean", async () => {
    const { unreplayed } = await replayPairs([ready("A1", "ana", anaShared)], [ready("X", "cy", "f".repeat(40))]);
    expect(unreplayed.map(([a, b]) => [a.taskId, b.taskId])).toEqual([["A1", "X"]]);
  });
});
