import { describe, expect, it } from "vitest";
import { adapterSupportsRemoteManagedEnvironments } from "@paperclipai/shared";
import { AGENT_ADAPTER_TYPES } from "@paperclipai/shared";
import { parseSettings, type PluginSettings } from "../src/config.js";
import { agentProblems, auditIsolation, auditSettingsIsolation, ENVIRONMENT_ADAPTERS, type AgentIsolationFacts } from "../src/isolation.js";

function settingsWith(raw: Record<string, unknown> = {}): PluginSettings {
  const r = parseSettings({
    people: [
      { email: "ana@example.com", agentId: "a1", agentEnvironmentId: "env-a", modelAccess: "subscription", timezone: "UTC", nightStartHour: 22, nightBudgetCapCents: 100 },
      { email: "bo@example.com", agentId: "b1", agentEnvironmentId: "env-b", modelAccess: "subscription", timezone: "UTC", nightStartHour: 22, nightBudgetCapCents: 100 },
    ],
    ...raw,
  });
  if (!r.ok) throw new Error(r.errors.join("; "));
  return r.settings;
}
const agent = (over: Partial<AgentIsolationFacts> = {}): AgentIsolationFacts => ({
  id: "a1",
  companyId: "co",
  role: "engineer",
  status: "idle",
  permissions: { canCreateAgents: false, canCreateSkills: false },
  adapterType: "claude_local",
  adapterConfig: { engine: "cli" },
  defaultEnvironmentId: "env-a",
  ...over,
});

describe("ENVIRONMENT_ADAPTERS", () => {
  it("is exactly Paperclip's list of adapters that run in the agent's environment", () => {
    const paperclips = [...AGENT_ADAPTER_TYPES, "paperclip_runner", "cursor"].filter((t) => adapterSupportsRemoteManagedEnvironments(t));
    expect([...new Set(paperclips)].sort()).toEqual([...ENVIRONMENT_ADAPTERS].sort());
    expect(adapterSupportsRemoteManagedEnvironments("process")).toBe(false);
  });
});

describe("auditIsolation", () => {
  const s = settingsWith();
  const ana = s.people[0]!;

  it("passes an agent that runs in its owner's own environment", () => {
    expect(auditIsolation(s, ana, agent())).toEqual([]);
    expect(agentProblems(s, ana, agent(), "co")).toEqual([]);
  });

  it("refuses an adapter that always runs as Paperclip's own user", () => {
    expect(auditIsolation(s, ana, agent({ adapterType: "process" })).join()).toContain("always runs as Paperclip's own system user");
  });

  it("refuses an agent in no environment, or in someone else's", () => {
    expect(auditIsolation(s, ana, agent({ defaultEnvironmentId: null })).join()).toContain("does not run in its owner's own environment");
    expect(auditIsolation(s, ana, agent({ defaultEnvironmentId: "env-b" })).join()).toContain("does not run in its owner's own environment");
  });

  it("refuses a person without an environment of their own", () => {
    const r = parseSettings({ people: [{ email: "c@example.com", agentId: "c1", timezone: "UTC", nightStartHour: 1, nightBudgetCapCents: 1 }] });
    if (!r.ok) throw new Error();
    expect(auditIsolation(r.settings, r.settings.people[0]!, agent({ id: "c1" })).join()).toContain("no environment of their own");
  });

  it("asks for Claude's CLI engine (Paperclip runs Claude over SSH only with it)", () => {
    expect(auditIsolation(s, ana, agent({ adapterConfig: {} })).join()).toContain('engine "cli"');
  });

  it("does nothing when isolation is turned off (test beds)", () => {
    const off = settingsWith({ isolation: { required: false } });
    expect(auditIsolation(off, off.people[0]!, agent({ adapterType: "process", defaultEnvironmentId: null }))).toEqual([]);
  });

  it("with test commands, needs each person's checks login", () => {
    const withChecks = settingsWith({ checks: { testCommand: "pnpm test", sandbox: { knownHosts: "127.0.0.1 ssh-ed25519 AAAA" } } });
    expect(auditSettingsIsolation(withChecks)).toEqual([]);
    expect(auditIsolation(withChecks, withChecks.people[0]!, agent()).join()).toContain("checks cannot run as this person's agent user");
  });

  it("flags test commands without a checks sandbox", () => {
    expect(auditSettingsIsolation(settingsWith({ checks: { lintCommand: "pnpm lint" } }))[0]).toContain("checks sandbox is not");
    expect(auditSettingsIsolation(settingsWith({ checks: { lintCommand: "pnpm lint" }, isolation: { required: false } }))).toEqual([]);
  });
});

describe("parseSettings: isolation fields", () => {
  it("defaults to isolation required", () => {
    expect(settingsWith().isolation.required).toBe(true);
  });

  it("never lets two people share an environment or a system user", () => {
    const r = parseSettings({
      people: [
        { email: "ana@example.com", agentId: "a1", agentEnvironmentId: "env-a", agentUser: "vt-a-1", timezone: "UTC", nightStartHour: 22, nightBudgetCapCents: 100 },
        { email: "bo@example.com", agentId: "b1", agentEnvironmentId: "env-a", agentUser: "vt-a-1", timezone: "UTC", nightStartHour: 22, nightBudgetCapCents: 100 },
      ],
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors).toContain("people[1].agentEnvironmentId: already used by another person's agent");
    expect(r.errors).toContain("people[1].agentUser: already used by another person's agent");
  });

  it.each([
    [{ host: "-oProxyCommand=x", knownHosts: "h k" }, "checks.sandbox.host: must be a host name or address"],
    [{ port: 0, knownHosts: "h k" }, "checks.sandbox.port: must be a whole number 1-65535"],
    [{}, "checks.sandbox.knownHosts: needs the host's known_hosts line"],
  ])("refuses option-like or missing sandbox values %o", (sandbox, message) => {
    const r = parseSettings({ people: [], checks: { sandbox } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors).toContain(message);
  });

  it("refuses a system user name that could be read as an option", () => {
    const r = parseSettings({ people: [{ email: "ana@example.com", agentId: "a1", agentUser: "-oX", timezone: "UTC", nightStartHour: 22, nightBudgetCapCents: 1 }] });
    expect(r.ok).toBe(false);
  });
});
