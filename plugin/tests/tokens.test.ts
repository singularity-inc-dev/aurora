import { describe, expect, it } from "vitest";
import { peekClaims, signLink, verifyLink, type LinkClaims } from "../src/tokens.js";
import { actionsIn, assertTier, TierRefused } from "../src/tiers.js";

const SECRET = "test-secret-" + "x".repeat(16);
const NOW = new Date("2026-10-22T07:00:00Z");
const claims: LinkClaims = { v: 1, a: "act-1", c: "co", o: "ana@example.com", t: "task-1", k: "approve", e: NOW.getTime() / 1000 + 3600 };

describe("signed links", () => {
  it("accepts a link signed with the right secret", () => {
    expect(verifyLink(signLink(claims, SECRET), SECRET, NOW)).toEqual({ ok: true, claims });
  });

  it("refuses an expired link", () => {
    expect(verifyLink(signLink({ ...claims, e: NOW.getTime() / 1000 - 1 }, SECRET), SECRET, NOW)).toEqual({ ok: false, reason: "expired" });
  });

  it("refuses a link signed with another secret", () => {
    expect(verifyLink(signLink(claims, "other-secret"), SECRET, NOW)).toEqual({ ok: false, reason: "invalid" });
  });

  it("refuses a link whose contents were changed (e.g. pointed at another person's task)", () => {
    const [, sig] = signLink(claims, SECRET).split(".");
    const tampered = Buffer.from(JSON.stringify({ ...claims, t: "someone-elses-task", o: "bo@example.com" })).toString("base64url");
    expect(verifyLink(`${tampered}.${sig}`, SECRET, NOW)).toEqual({ ok: false, reason: "invalid" });
  });

  it.each(["", "abc", "a.b.c", "!!!.???"])("refuses garbage %j", (token) => {
    expect(verifyLink(token, SECRET, NOW).ok).toBe(false);
  });

  it("peeks at the company only for routing", () => {
    expect(peekClaims(signLink(claims, SECRET))?.c).toBe("co");
    expect(peekClaims("not-a-token")).toBeNull();
  });
});

describe("action tiers", () => {
  it("merge and reject need a tap; nothing else does", () => {
    expect(actionsIn("needs-tap").sort()).toEqual(["merge-task", "reject-task"]);
    expect(() => assertTier("merge-task", "needs-tap")).not.toThrow();
  });

  it("an automatic action cannot pose as a tapped one, and the reverse", () => {
    expect(() => assertTier("send-morning-briefing", "needs-tap")).toThrow(TierRefused);
    expect(() => assertTier("merge-task", "automatic")).toThrow(TierRefused);
  });

  it.each(["deploy", "push-to-remote", "delete-branch", "spend", "send-external-message"])("%s is never allowed", (action) => {
    expect(() => assertTier(action, "needs-tap")).toThrow("never allowed");
    expect(() => assertTier(action, "automatic")).toThrow("never allowed");
  });

  it("unknown actions are refused", () => {
    expect(() => assertTier("format-disk", "automatic")).toThrow("unknown action");
  });
});
