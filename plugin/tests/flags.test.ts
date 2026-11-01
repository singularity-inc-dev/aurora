import { describe, expect, it } from "vitest";
import { cleanDetail, describeFlags, flagsOf } from "../src/flags.js";
import { listFlagsForCompany, listFlagsForTask, recordFlag, recordFlagSafely } from "../src/flagstore.js";
import { createFakeDb } from "./fakedb.js";

describe("flagsOf", () => {
  it("has no flags for a clean task", () => {
    expect(flagsOf({ checks_result: "passed", outcome: null }, [])).toEqual([]);
    expect(flagsOf(null, [])).toEqual([]);
  });

  it("reads failed checks, not tested and rejected (with its reason) from the event log", () => {
    expect(flagsOf({ checks_result: "failed" }, [])).toEqual([{ kind: "checks-failed", detail: null }]);
    expect(flagsOf({ checks_result: "not-tested" }, [])).toEqual([{ kind: "not-tested", detail: "no test command ran" }]);
    expect(flagsOf({ outcome: "rejected", reject_reason: "wrong approach" }, [])).toEqual([{ kind: "rejected", detail: "wrong approach" }]);
    expect(flagsOf({ outcome: "rejected", reject_reason: null }, [])).toEqual([{ kind: "rejected", detail: "no reason given" }]);
  });

  it("does not flag 'no changes' or a task that was merely blocked", () => {
    expect(flagsOf({ checks_result: "no-changes", outcome: "blocked" }, [])).toEqual([]);
  });

  it("adds the stored flags and always lists them in the same order", () => {
    const stored = [
      { kind: "budget-stop" as const, detail: "cap" },
      { kind: "tool-error" as const, detail: "run_checks: no worktree" },
      { kind: "timeout" as const, detail: null },
    ];
    expect(flagsOf({ checks_result: "failed", outcome: "rejected", reject_reason: "no" }, stored).map((f) => f.kind)).toEqual([
      "tool-error",
      "checks-failed",
      "timeout",
      "budget-stop",
      "rejected",
    ]);
  });

  it("a checks flag follows the latest result: failed checks that later pass are no longer flagged", () => {
    expect(flagsOf({ checks_result: "failed" }, []).length).toBe(1);
    expect(flagsOf({ checks_result: "passed" }, [])).toEqual([]);
  });
});

describe("describeFlags and cleanDetail", () => {
  it("reads as one short line", () => {
    expect(describeFlags([{ kind: "checks-failed", detail: null }, { kind: "timeout", detail: "after 2 tries" }])).toBe("checks failed, timed out (after 2 tries)");
  });
  it("squeezes a detail to one line of at most 200 characters", () => {
    expect(cleanDetail("a\n  b\tc")).toBe("a b c");
    expect(cleanDetail("   ")).toBeNull();
    expect(cleanDetail("x".repeat(500))!.length).toBe(200);
  });
});

describe("flag store", () => {
  it("keeps one row per task and kind, and a repeat updates the detail", async () => {
    const db = createFakeDb();
    await recordFlag(db, "co", "t1", "timeout", "retrying (attempt 2)");
    await recordFlag(db, "co", "t1", "timeout", "timed out 2 time(s)");
    await recordFlag(db, "co", "t1", "tool-error", "run_checks: nope");
    expect(db.tables.run_flags).toHaveLength(2);
    expect(await listFlagsForTask(db, "t1")).toEqual([
      { kind: "timeout", detail: "timed out 2 time(s)" },
      { kind: "tool-error", detail: "run_checks: nope" },
    ]);
  });

  it("lists a company's flags by task and ignores other companies", async () => {
    const db = createFakeDb();
    await recordFlag(db, "co", "t1", "budget-stop", null);
    await recordFlag(db, "other", "t2", "budget-stop", null);
    const byTask = await listFlagsForCompany(db, "co");
    expect([...byTask.keys()]).toEqual(["t1"]);
  });

  it("recordFlagSafely never throws, so a failed write cannot hide the real error", async () => {
    const db = createFakeDb();
    db.execute = async () => {
      throw new Error("database is down");
    };
    const messages: string[] = [];
    await expect(recordFlagSafely(db, "co", "t1", "tool-error", "x", (m) => messages.push(m))).resolves.toBe(false);
    expect(messages[0]).toContain("database is down");
  });
});
