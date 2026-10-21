import { describe, expect, it } from "vitest";
import { parseSettings, type PluginSettings } from "../src/config.js";
import { handoffDescription, HandoffRefused, parseHandoffRequest, planHandoff } from "../src/handoff.js";

function settings(): PluginSettings {
  const base = { timezone: "Europe/London", nightStartHour: 22, nightBudgetCapCents: 500 };
  const r = parseSettings({
    people: [
      { ...base, email: "ana@example.com", agentId: "agent-ana" },
      { ...base, email: "bo@example.com", agentId: "agent-bo" },
    ],
  });
  if (!r.ok) throw new Error(r.errors.join(";"));
  return r.settings;
}

describe("planHandoff", () => {
  it("plans a new ticket for a configured teammate", () => {
    const plan = planHandoff(settings(), "agent-ana", { toEmail: "BO@example.com", title: "Fix login" });
    expect(plan).toMatchObject({ kind: "create", title: "Fix login", to: { agentId: "agent-bo" } });
    if (plan.kind === "create") expect(handoffDescription(plan)).toContain("ana@example.com");
  });

  it("plans an assignment of an existing ticket", () => {
    expect(planHandoff(settings(), "agent-ana", { toEmail: "bo@example.com", issueId: "iss-1" })).toMatchObject({
      kind: "assign",
      issueId: "iss-1",
    });
  });

  it.each([
    ["agent-x", { toEmail: "bo@example.com", title: "t" }, "not bound"],
    ["agent-ana", { toEmail: "", title: "t" }, "toEmail is required"],
    ["agent-ana", { toEmail: "stranger@example.com", title: "t" }, "not a configured teammate"],
    ["agent-ana", { toEmail: "ana@example.com", title: "t" }, "yourself"],
    ["agent-ana", { toEmail: "bo@example.com" }, "title is required"],
    ["agent-ana", { toEmail: "bo@example.com", title: "x".repeat(201) }, "title is longer"],
    ["agent-ana", { toEmail: "bo@example.com", title: "t", description: "x".repeat(10_001) }, "description is longer"],
  ])("refuses %s %o", (agent, req, message) => {
    expect(() => planHandoff(settings(), agent, req)).toThrow(HandoffRefused);
    expect(() => planHandoff(settings(), agent, req)).toThrow(message);
  });
});

describe("parseHandoffRequest", () => {
  it("keeps only known text fields", () => {
    expect(parseHandoffRequest({ toEmail: " bo@example.com ", title: "t", extra: 1, issueId: 5 })).toEqual({
      toEmail: "bo@example.com",
      title: "t",
    });
    expect(parseHandoffRequest(null)).toEqual({ toEmail: "" });
  });
});
