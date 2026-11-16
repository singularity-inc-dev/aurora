import { describe, expect, it } from "vitest";
import { classify, renderBriefing, type TaskFacts } from "../src/briefing.js";
import type { Briefing } from "../src/briefstore.js";
import { verifyLink } from "../src/tokens.js";

const facts = (o: Partial<TaskFacts> = {}): TaskFacts => ({
  taskId: "t1",
  identifier: "VT-1",
  title: "Fix login",
  issueStatus: "done",
  outcome: null,
  decisionActionId: null,
  startedAt: "2026-10-21T22:00:00Z",
  checksResult: "passed",
  checksHead: "abc1234",
  worktree: { cwd: "/w", branch: "vt/VT-1-fix-login", baseRef: "main" },
  branchHead: "abc1234",
  clean: true,
  summary: "Fix login: 1 file changed",
  ...o,
});

describe("classify", () => {
  it("is Ready only when checks passed on exactly the branch head", () => {
    expect(classify(facts())).toMatchObject({ category: "ready", approvable: true });
  });

  it("NOT TESTED (no test command) is never shown as passed; the owner may still approve, knowing that", () => {
    const c = classify(facts({ checksResult: "not-tested" }));
    expect(c).toMatchObject({ category: "ready", approvable: true });
    expect(c.checks).toContain("NOT TESTED");
    expect(c.checks).not.toMatch(/passed/i);
    expect(classify(facts({ checksResult: "not-tested", branchHead: "def5678" })).approvable).toBe(false);
  });

  it.each([
    [{ outcome: "failed" }, "failed", "timed out"],
    [{ outcome: "blocked" }, "blocked", "stopped by the handover"],
    [{ startedAt: null }, "blocked", "not started"],
    [{ issueStatus: "in_progress" }, "blocked", "in_progress"],
    [{ worktree: null }, "blocked", "no worktree"],
    [{ clean: false }, "blocked", "uncommitted"],
    [{ checksResult: "failed" }, "blocked", "checks failed"],
    [{ checksResult: null }, "blocked", "checks not run"],
    [{ checksResult: "no-changes" }, "blocked", "committed nothing"],
    [{ branchHead: "def5678" }, "blocked", "latest commit"],
  ] as const)("%o -> %s", (patch, category, reason) => {
    const c = classify(facts(patch as Partial<TaskFacts>));
    expect(c.category).toBe(category);
    expect(c.approvable).toBe(false);
    expect(c.reason).toContain(reason);
  });
});

describe("renderBriefing", () => {
  const secret = "s".repeat(32);
  const exp = new Date("2026-10-23T07:00:00Z");
  const b: Briefing = {
    id: "b1",
    companyId: "co",
    owner: "ana@example.com",
    handoverKey: "2026-10-21",
    status: "pending",
    notes: [],
    conflicts: [],
    items: [
      { taskId: "t1", identifier: "VT-1", title: "Fix login", category: "ready", summary: "Fix login: 1 file changed, 2 insertions(+)", checks: "checks passed on abc1234", reason: null, approveActionId: "a1", rejectActionId: "r1" },
      { taskId: "t2", identifier: "VT-2", title: "Docs <draft>", category: "blocked", summary: "Docs <draft>", checks: "checks failed", reason: "checks failed", approveActionId: null, rejectActionId: "r2" },
      { taskId: "t3", identifier: "VT-3", title: "Big", category: "failed", summary: "Big", checks: "checks not run", reason: "timed out after its retries", approveActionId: null, rejectActionId: "r3" },
    ],
  };
  const email = renderBriefing(b, { baseUrl: "http://mail.test", signingSecret: { type: "secret_ref", secretId: "x" }, expiresMinutes: 60 }, secret, exp);

  it("has Ready, Blocked and Failed sections with counts in the subject", () => {
    expect(email.subject).toBe("Your handover of 2026-10-21: 1 ready, 1 blocked, 1 failed");
    expect(email.text).toMatch(/READY \(1\)[\s\S]*BLOCKED \(1\)[\s\S]*FAILED \(1\)/);
    expect(email.to).toBe("ana@example.com");
  });

  it("shows what changed, the checks result and links for each task", () => {
    expect(email.text).toContain("VT-1 Fix login: 1 file changed, 2 insertions(+)");
    expect(email.text).toContain("checks passed on abc1234");
    expect((email.text.match(/Approve: /g) ?? []).length).toBe(1); // only Ready can be approved
    expect((email.text.match(/Reject: /g) ?? []).length).toBe(3);
  });

  it("links are signed for the owner, the task and the action", () => {
    const token = /Approve: http:\/\/mail\.test\/l\/(\S+)/.exec(email.text)![1]!;
    const v = verifyLink(token, secret, new Date("2026-10-22T07:00:00Z"));
    expect(v).toMatchObject({ ok: true, claims: { a: "a1", o: "ana@example.com", t: "t1", k: "approve", c: "co" } });
  });

  it("escapes HTML and lists the action tiers", () => {
    expect(email.html).toContain("Docs &lt;draft&gt;");
    expect(email.html).not.toContain("Docs <draft>");
    expect(email.text).toContain("Never: deploy, push-to-base-branch-directly");
  });
});

describe("renderBriefing: flagged work goes first", () => {
  const secret = "s".repeat(32);
  const exp = new Date("2026-10-23T07:00:00Z");
  const links = { baseUrl: "http://mail.test", signingSecret: { type: "secret_ref" as const, secretId: "x" }, expiresMinutes: 60 };
  const item = (id: string, category: "ready" | "blocked" | "failed" | "waiting", flags?: Array<{ kind: "tool-error" | "checks-failed" | "not-tested" | "timeout" | "budget-stop" | "rejected"; detail: string | null }>) => ({
    taskId: id,
    identifier: id.toUpperCase(),
    title: `Task ${id}`,
    category,
    summary: `Task ${id}`,
    checks: "checks passed on abc1234",
    reason: category === "ready" ? null : "why",
    approveActionId: category === "ready" ? `a-${id}` : null,
    rejectActionId: `r-${id}`,
    ...(flags ? { flags } : {}),
  });
  const b: Briefing = {
    id: "b1",
    companyId: "co",
    owner: "ana@example.com",
    handoverKey: "2026-10-21",
    status: "pending",
    notes: ["A note."],
    conflicts: [],
    items: [
      item("t1", "ready"),
      item("t2", "ready", [{ kind: "not-tested", detail: "no test command ran" }]),
      item("t3", "blocked", [{ kind: "tool-error", detail: "run_checks: no worktree" }, { kind: "checks-failed", detail: null }]),
      item("t4", "failed", [{ kind: "timeout", detail: "timed out 2 time(s) after 60 minutes" }]),
      item("t5", "blocked"),
    ],
  };
  const email = renderBriefing(b, links, secret, exp);

  it("puts a 'needs your attention first' block before everything else", () => {
    const text = email.text;
    expect(text.indexOf("NEEDS YOUR ATTENTION FIRST (3)")).toBeGreaterThan(-1);
    expect(text.indexOf("NEEDS YOUR ATTENTION FIRST (3)")).toBeLessThan(text.indexOf("Note: A note."));
    expect(text.indexOf("NEEDS YOUR ATTENTION FIRST (3)")).toBeLessThan(text.indexOf("READY ("));
    expect(email.html.indexOf("Needs your attention first (3)")).toBeLessThan(email.html.indexOf("<h2>Ready"));
  });

  it("names each flag, with its detail, and keeps Approve and Reject on the flagged item", () => {
    expect(email.text).toContain("Ready. Flags: not tested (no test command ran)");
    expect(email.text).toContain("Blocked. Flags: tool error (run_checks: no worktree), checks failed");
    expect(email.text).toContain("Failed. Flags: timed out (timed out 2 time(s) after 60 minutes)");
    const attention = email.text.slice(email.text.indexOf("NEEDS YOUR ATTENTION"), email.text.indexOf("READY ("));
    expect((attention.match(/Approve: /g) ?? []).length).toBe(1); // t2 is the flagged one that can be approved
    expect((attention.match(/Reject: /g) ?? []).length).toBe(3);
  });

  it("shows each task once: the sections below hold only the unflagged ones and say how many are above", () => {
    expect(email.text).toContain("READY (2, 1 flagged above)");
    expect(email.text).toContain("BLOCKED (2, 1 flagged above)");
    expect(email.text).toContain("FAILED (1, 1 flagged above)\n  none more");
    for (const id of ["t1", "t5"]) expect(email.text.split(`${id.toUpperCase()} Task ${id}`).length - 1).toBe(1);
    for (const id of ["t2", "t3", "t4"]) expect(email.text.split(`${id.toUpperCase()} Task ${id}`).length - 1).toBe(1);
  });

  it("counts flagged tasks in the subject; the ready/blocked/failed counts stay the same", () => {
    expect(email.subject).toBe("Your handover of 2026-10-21: 2 ready, 2 blocked, 1 failed, 3 flagged");
  });

  it("looks the same as before when nothing is flagged", () => {
    const plain = renderBriefing({ ...b, items: b.items.map(({ flags: _f, ...rest }) => rest) }, links, secret, exp);
    expect(plain.text).not.toContain("NEEDS YOUR ATTENTION");
    expect(plain.text).toContain("READY (2)");
    expect(plain.subject).toBe("Your handover of 2026-10-21: 2 ready, 2 blocked, 1 failed");
  });

  it("does not shout about a task that is only waiting for review on GitHub", () => {
    const waiting = { ...item("t6", "waiting", [{ kind: "not-tested", detail: null }]), approveActionId: null, rejectActionId: null };
    const e = renderBriefing({ ...b, items: [waiting] }, links, secret, exp);
    expect(e.text).not.toContain("NEEDS YOUR ATTENTION");
  });
});
