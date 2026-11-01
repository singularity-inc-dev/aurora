import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  briefComment,
  fileAllowed,
  insertNote,
  noteForTask,
  notesOf,
  notesOfRun,
  parseNoteInput,
  queuedTaskIds,
  startQueuedNote,
  ticketDigest,
  withdrawNote,
  type NewNote,
} from "../src/notes.js";
import { createFakeDb } from "./fakedb.js";

const bounds = { defaultMinutes: 120, maxMinutes: 480, defaultBudgetCents: 500, maxBudgetCents: 500 };
const good = { issueId: "i1", what: "Add a greeting", doneWhen: "greeting.txt says hello", files: "greeting.txt, docs/" };

describe("the handover note: what, done when, limits", () => {
  it("accepts a complete note and fills the default time and budget", () => {
    expect(parseNoteInput(good, bounds)).toEqual({
      issueId: "i1",
      what: "Add a greeting",
      doneWhen: "greeting.txt says hello",
      claims: ["greeting.txt", "docs"],
      maxMinutes: 120,
      budgetCents: 500,
    });
  });

  it("keeps the owner's own time and budget", () => {
    const n = parseNoteInput({ ...good, maxMinutes: "30", budgetCents: "75" }, bounds);
    expect(n).toMatchObject({ maxMinutes: 30, budgetCents: 75 });
  });

  it.each([
    [{ what: "" }, "write what to do"],
    [{ doneWhen: "  " }, 'write how you will know it is done ("Done when")'],
    [{ files: "" }, 'list the files or folders it may change (for example "src/ui/, README.md")'],
    [{ files: "../etc/passwd" }, '"../etc/passwd" must be a path inside the repository ("*", "?" and "**" allowed)'],
    [{ maxMinutes: "4" }, "the time limit must be 5 to 480 minutes"],
    [{ maxMinutes: "481" }, "the time limit must be 5 to 480 minutes"],
    [{ maxMinutes: "1.5" }, "the time limit must be a whole number of minutes"],
    [{ budgetCents: "0" }, "the budget must be 1 to 500 cents (your cap per handover)"],
    [{ budgetCents: "501" }, "the budget must be 1 to 500 cents (your cap per handover)"],
    [{ budgetCents: "-3" }, "the budget must be a whole number of US cents"],
    [{ issueId: "" }, "no ticket chosen"],
  ])("refuses %j", (change, message) => {
    expect(parseNoteInput({ ...good, ...change }, bounds)).toBe(message);
  });

  it("a changed file must be inside the note's files", () => {
    const claims = ["greeting.txt", "docs", "src/**/*.css"];
    expect(fileAllowed("greeting.txt", claims)).toBe(true);
    expect(fileAllowed("docs/guide/intro.md", claims)).toBe(true);
    expect(fileAllowed("src/ui/a/b.css", claims)).toBe(true);
    expect(fileAllowed("src/ui/a/b.ts", claims)).toBe(false);
    expect(fileAllowed("README.md", claims)).toBe(false);
    expect(fileAllowed("docsx/a.md", claims)).toBe(false);
  });

  it("the ticket fingerprint changes when the title or description changes", () => {
    const a = ticketDigest("Fix login", "Users see a 500");
    expect(ticketDigest("Fix login", "Users see a 500")).toBe(a);
    expect(ticketDigest("Fix login", "Users see a 404")).not.toBe(a);
    expect(ticketDigest("Fix logout", "Users see a 500")).not.toBe(a);
  });

  it("the agent's brief shows the note and the limits", () => {
    const text = briefComment("ana@example.com", { what: "Add a greeting", doneWhen: "it says hello", claims: ["greeting.txt"], maxMinutes: 30, budgetCents: 75, schedule: "scheduled" });
    expect(text).toContain("**What to do:** Add a greeting");
    expect(text).toContain("**Done when:** it says hello");
    expect(text).toContain("Change only: `greeting.txt`");
    expect(text).toContain("Time: 30 minutes.");
    expect(text).toContain("Budget: 75 cents.");
    expect(text).toContain("call `run_checks`");
    expect(text).toContain("next scheduled handover, not before");
  });
});

describe("note storage", () => {
  const base = (over: Partial<NewNote> = {}): NewNote => ({
    companyId: "c1",
    owner: "ana@example.com",
    agentId: "a1",
    taskId: "t1",
    source: "owner",
    status: "queued",
    schedule: "scheduled",
    handoverKey: null,
    title: "Greeting",
    what: "Add a greeting",
    doneWhen: "it says hello",
    claims: ["greeting.txt"],
    maxMinutes: 30,
    budgetCents: 75,
    ticketDigest: "d",
    submittedBy: "ana@example.com",
    ...over,
  });

  it("stores the note in one table and reads it back whole", async () => {
    const db = createFakeDb();
    const id = await insertNote(db, base());
    const [n] = await notesOf(db, "c1", "ana@example.com", "queued");
    expect(n).toMatchObject({ id, taskId: "t1", what: "Add a greeting", claims: ["greeting.txt"], maxMinutes: 30, budgetCents: 75, schedule: "scheduled" });
    expect(await queuedTaskIds(db, "c1")).toEqual(new Set(["t1"]));
  });

  it("a queued note starts in exactly one run (compare-and-swap)", async () => {
    const db = createFakeDb();
    const id = await insertNote(db, base());
    expect(await startQueuedNote(db, id, "2026-11-01")).toBe(true);
    expect(await startQueuedNote(db, id, "2026-11-02")).toBe(false);
    expect((await notesOfRun(db, "c1", "ana@example.com", "2026-11-01")).map((n) => n.id)).toEqual([id]);
    expect((await noteForTask(db, "t1"))?.handoverKey).toBe("2026-11-01");
    expect(await withdrawNote(db, id, "queued")).toBe(false);
  });

  it("a queued note can be withdrawn before it starts", async () => {
    const db = createFakeDb();
    const id = await insertNote(db, base());
    expect(await withdrawNote(db, id, "queued")).toBe(true);
    expect(await startQueuedNote(db, id, "2026-11-01")).toBe(false);
    expect(await queuedTaskIds(db, "c1")).toEqual(new Set());
  });

  it("the migration targets the plugin's namespace and allows one queued note per ticket", () => {
    const sql = readFileSync(new URL("../migrations/011_handover_notes.sql", import.meta.url), "utf8");
    expect(sql).toContain('"plugin_vision_and_tom_d7896c8063".handover_notes');
    for (const col of ["what", "done_when", "claims", "max_minutes", "budget_cents", "status", "ticket_digest"]) expect(sql).toContain(col);
    expect(sql).toMatch(/UNIQUE INDEX[^;]*\(task_id\) WHERE status = 'queued'/);
  });

  it("new migrations have no apostrophe in a comment (Paperclip 2026.1012.0 reads it as a quote and refuses the plugin)", async () => {
    const { readdirSync } = await import("node:fs");
    const dir = new URL("../migrations/", import.meta.url);
    // 001-010 are already installed on servers and must not change; 005 has one that happens to pass.
    for (const f of readdirSync(dir).filter((x) => Number(x.slice(0, 3)) >= 11)) {
      const bad = readFileSync(new URL(f, dir), "utf8").split("\n").filter((l) => l.trim().startsWith("--") && l.includes("'"));
      expect(bad, f).toEqual([]);
    }
  });
});
