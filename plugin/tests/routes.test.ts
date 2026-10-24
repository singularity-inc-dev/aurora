import { describe, expect, it } from "vitest";
import manifest from "../src/manifest.js";
import { auditAgentRoutes, FORBIDDEN_CAPABILITIES, type AgentRouteFacts } from "../src/routes.js";

const locked: AgentRouteFacts = {
  id: "a1",
  companyId: "co",
  role: "engineer",
  status: "idle",
  permissions: { canCreateAgents: false, canCreateSkills: false },
};

describe("auditAgentRoutes", () => {
  it("passes a locked-down agent", () => {
    expect(auditAgentRoutes(locked, "co")).toEqual([]);
  });

  it("flags Paperclip's default permissions (agents can create agents and skills)", () => {
    const problems = auditAgentRoutes({ ...locked, permissions: { canCreateAgents: true, canCreateSkills: true } }, "co");
    expect(problems).toHaveLength(2);
  });

  it("treats a missing permission as unsafe", () => {
    expect(auditAgentRoutes({ ...locked, permissions: {} }, "co")).toHaveLength(2);
  });

  it.each([
    [{ role: "ceo" }, "CEO"],
    [{ status: "terminated" }, "terminated"],
    [{ companyId: "other" }, "another company"],
  ])("flags %o", (patch, word) => {
    expect(auditAgentRoutes({ ...locked, ...patch }, "co").join(" ")).toContain(word);
  });

  it("flags a missing agent", () => {
    expect(auditAgentRoutes(null, "co")).toEqual(["agent not found"]);
  });
});

describe("manifest capabilities", () => {
  it("never asks for agent-to-agent, merge, send, delete or spend capabilities", () => {
    for (const cap of FORBIDDEN_CAPABILITIES) expect(manifest.capabilities).not.toContain(cap);
  });
});
