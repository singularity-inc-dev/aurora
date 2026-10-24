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

  it.each([
    [{ outcome: "failed" }, "failed", "timed out"],
    [{ outcome: "blocked" }, "blocked", "stopped by the night routine"],
    [{ startedAt: null }, "blocked", "not started"],
    [{ issueStatus: "in_progress" }, "blocked", "in_progress"],
    [{ worktree: null }, "blocked", "no worktree"],
    [{ clean: false }, "blocked", "uncommitted"],
    [{ checksResult: "failed" }, "blocked", "checks failed"],
    [{ checksResult: null }, "blocked", "checks not run"],
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
    nightDate: "2026-10-21",
    status: "pending",
    notes: [],
    items: [
      { taskId: "t1", identifier: "VT-1", title: "Fix login", category: "ready", summary: "Fix login: 1 file changed, 2 insertions(+)", checks: "checks passed on abc1234", reason: null, approveActionId: "a1", rejectActionId: "r1" },
      { taskId: "t2", identifier: "VT-2", title: "Docs <draft>", category: "blocked", summary: "Docs <draft>", checks: "checks failed", reason: "checks failed", approveActionId: null, rejectActionId: "r2" },
      { taskId: "t3", identifier: "VT-3", title: "Big", category: "failed", summary: "Big", checks: "checks not run", reason: "timed out after its retries", approveActionId: null, rejectActionId: "r3" },
    ],
  };
  const email = renderBriefing(b, { baseUrl: "http://mail.test", signingSecret: { type: "secret_ref", secretId: "x" }, expiresMinutes: 60 }, secret, exp);

  it("has Ready, Blocked and Failed sections with counts in the subject", () => {
    expect(email.subject).toBe("Your night of 2026-10-21: 1 ready, 1 blocked, 1 failed");
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
