import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { parseCodeowners } from "../src/claims.js";
import type { Person } from "../src/config.js";
import { MAX_QUESTIONS, movedTicketNote, ownerQuestions, preHandoverCheck, type Areas, type OpenClaim, type Verdict } from "../src/prehandover.js";
import { readAreas } from "../src/repoareas.js";

const person = (email: string, githubLogin: string | null = null): Person => ({
  email,
  agentId: `agent-${email}`,
  agentEnvironmentId: null,
  agentUser: null,
  checksKey: null,
  modelAccess: null,
  githubLogin,
  timezone: "UTC",
  handoverStartHour: 22,
  maxTasksPerHandover: 3,
  handoverBudgetCapCents: 500,
  secrets: [],
});
const ana = person("ana@example.com", "ana");
const bo = person("bo@example.com", "bo-dev");
const cy = person("cy@example.com");
const team = [ana, bo, cy];
const areas = (codeowners: string, files: string[] = []): Areas => ({ rules: parseCodeowners(codeowners).rules, files: new Set(files), source: "CODEOWNERS" });
const OWNERS = "*  @lead\n/src/ui/  @ana\n/src/api/  @bo-dev cy@example.com\n";

describe("pre-handover check", () => {
  it("keeps tasks inside the proposer's own area or nobody's", () => {
    const v = preHandoverCheck(ana, team, [{ title: "Button", claims: ["src/ui/button.tsx"] }, { title: "Readme", claims: ["README.md"] }], [], areas(OWNERS));
    expect(v.map((x) => x.overlap)).toEqual([null, null]);
  });

  it("moves a task that reaches into another owner's area to that owner", () => {
    const [v] = preHandoverCheck(ana, team, [{ title: "Search", claims: ["src/ui/search.tsx", "src/api/search.ts"] }], [], areas(OWNERS));
    expect(v!.overlap).toMatchObject({ kind: "area", claim: "src/api/search.ts", keeper: { email: "bo@example.com" }, rule: { line: 3 } });
  });

  it("lets any co-owner of an area change it", () => {
    const [v] = preHandoverCheck(cy, team, [{ title: "Index", claims: ["src/api/db.ts"] }], [], areas(OWNERS));
    expect(v!.overlap).toBeNull();
  });

  it("moves a task whose files another owner's open task already claimed", () => {
    const open: OpenClaim[] = [{ taskId: "T-1", owner: "bo@example.com", title: "Rename users", claims: ["docs"] }];
    const [v] = preHandoverCheck(ana, team, [{ title: "Docs", claims: ["docs/guide.md"] }], open, null);
    expect(v!.overlap).toMatchObject({ kind: "claim", keeper: { email: "bo@example.com" }, otherClaim: "docs", other: { taskId: "T-1" } });
  });

  it("an owner's own open tasks never block them", () => {
    const open: OpenClaim[] = [{ taskId: "T-1", owner: "ana@example.com", title: "Earlier", claims: ["docs"] }];
    expect(preHandoverCheck(ana, team, [{ title: "Docs", claims: ["docs"] }], open, null)[0]!.overlap).toBeNull();
  });

  it("the area owner comes before the earlier claim", () => {
    const open: OpenClaim[] = [{ taskId: "T-1", owner: "cy@example.com", title: "Cy's", claims: ["src/ui"] }];
    const [v] = preHandoverCheck(bo, team, [{ title: "Theme", claims: ["src/ui/theme.css"] }], open, areas(OWNERS));
    expect(v!.overlap).toMatchObject({ kind: "area", keeper: { email: "ana@example.com" } });
  });

  it("knows a file from a folder when the repository says so", () => {
    const codeowners = "*.sql  @bo-dev\n";
    expect(preHandoverCheck(ana, team, [{ title: "X", claims: ["src/a.ts"] }], [], areas(codeowners, ["src/a.ts"]))[0]!.overlap).toBeNull();
    // Not in the repository yet: it might become a folder with .sql files in it.
    expect(preHandoverCheck(ana, team, [{ title: "X", claims: ["src/a.ts"] }], [], areas(codeowners))[0]!.overlap).not.toBeNull();
  });

  it("owners not on the team, and areas with no owners, block nobody", () => {
    const [v] = preHandoverCheck(ana, team, [{ title: "Root", claims: ["Makefile"] }], [], areas("*  @lead @org/team\n/docs/\n"));
    expect(v!.overlap).toBeNull();
  });
});

describe("questions to the owner", () => {
  const moved = (n: number) =>
    Array.from({ length: n }, (_, i) => {
      const [v] = preHandoverCheck(ana, team, [{ title: `Task ${i + 1}`, claims: ["src/api/x.ts"] }], [], areas(OWNERS));
      return { verdict: v as Verdict & { overlap: NonNullable<Verdict["overlap"]> }, ticket: `T-${i + 1}` };
    });

  it("asks one question per moved task", () => {
    const q = ownerQuestions(moved(2));
    expect(q).toHaveLength(2);
    expect(q[0]).toContain('"Task 1": `src/api/x.ts` is in bo@example.com\'s area (CODEOWNERS line 3)');
    expect(q[0]).toContain("went to bo@example.com's agent as T-1 and will not run in your handover");
  });

  it("never asks more than three", () => {
    const q = ownerQuestions(moved(5));
    expect(q).toHaveLength(MAX_QUESTIONS);
    expect(q[2]).toMatch(/^3 more tasks .*"Task 3" \(T-3, bo@example.com\); "Task 4".*"Task 5" \(T-5/);
  });

  it("the keeper's ticket says why it came to them", () => {
    const [m] = moved(1);
    expect(movedTicketNote(ana, m!.verdict)).toContain("ana@example.com's agent proposed this, but `src/api/x.ts` is in bo@example.com's area");
  });
});

describe("owner areas from the repository", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "vt-areas-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const g = (...args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "pipe" }).toString();
  g("init", "-q", "-b", "main");
  g("config", "user.email", "t@example.com");
  g("config", "user.name", "t");
  mkdirSync(path.join(dir, ".github"));
  mkdirSync(path.join(dir, "src"));
  writeFileSync(path.join(dir, "src/app.ts"), "x\n");
  writeFileSync(path.join(dir, "CODEOWNERS"), "* @root\n");
  writeFileSync(path.join(dir, ".github/CODEOWNERS"), "/src/ @ana\n[bad] @x\n");
  g("add", ".");
  g("commit", "-qm", "init");

  it("reads the committed CODEOWNERS in GitHub's order and the repository's files", async () => {
    const { areas: a, notes } = await readAreas(dir);
    expect(a.source).toBe(".github/CODEOWNERS");
    expect(a.rules.map((r) => r.owners)).toEqual([["@ana"]]);
    expect(a.files.has("src/app.ts")).toBe(true);
    expect(notes).toEqual([".github/CODEOWNERS: line(s) 2 could not be read and were left out."]);
  });

  it("ignores uncommitted changes, which an agent could have made", async () => {
    writeFileSync(path.join(dir, ".github/CODEOWNERS"), "* @mallory\n");
    expect((await readAreas(dir)).areas.rules[0]!.owners).toEqual(["@ana"]);
  });

  it("says so when there is no CODEOWNERS", async () => {
    g("rm", "-qf", "CODEOWNERS", ".github/CODEOWNERS");
    g("commit", "-qm", "no owners");
    const { areas: a, notes } = await readAreas(dir);
    expect(a.rules).toEqual([]);
    expect(notes[0]).toMatch(/No CODEOWNERS file/);
  });

  it("throws when the repository cannot be read", async () => {
    await expect(readAreas(path.join(dir, "missing"))).rejects.toThrow();
    await expect(readAreas(dir, "no-such-branch")).rejects.toThrow();
  });
});
