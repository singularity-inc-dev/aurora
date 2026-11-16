import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseSettings, type PluginSettings } from "../src/config.js";
import type { AgentIsolationFacts } from "../src/isolation.js";
import { auditModelAccess } from "../src/modelaccess.js";

const ref = (secretId: string) => ({ type: "secret_ref", secretId });
function settingsWith(people: Array<Record<string, unknown>>): PluginSettings {
  const r = parseSettings({ people: people.map((p, i) => ({ email: `p${i}@example.com`, agentId: `a${i}`, timezone: "UTC", handoverStartHour: 22, handoverBudgetCapCents: 1, ...p })) });
  if (!r.ok) throw new Error(r.errors.join("; "));
  return r.settings;
}
const agent = (env: Record<string, unknown> = {}, adapterType = "claude_local"): AgentIsolationFacts => ({
  id: "a0",
  companyId: "co",
  role: "engineer",
  status: "idle",
  permissions: { canCreateAgents: false, canCreateSkills: false },
  adapterType,
  adapterConfig: { engine: "cli", env },
  defaultEnvironmentId: "e",
});

describe("auditModelAccess", () => {
  it("asks each owner to choose their own Claude access first", () => {
    const s = settingsWith([{}]);
    expect(auditModelAccess(s, s.people[0]!, agent())[0]).toContain("no Claude access chosen");
  });

  it("subscription: the agent is given no key or token at all", () => {
    const s = settingsWith([{ modelAccess: "subscription" }]);
    expect(auditModelAccess(s, s.people[0]!, agent())).toEqual([]);
    expect(auditModelAccess(s, s.people[0]!, agent({ ANTHROPIC_API_KEY: "sk-plain" })).join()).toContain("uses their own subscription");
    expect(auditModelAccess(s, s.people[0]!, agent({ CLAUDE_CODE_OAUTH_TOKEN: ref("x") })).join()).toContain("CLAUDE_CODE_OAUTH_TOKEN");
  });

  it("api-key: the agent's ANTHROPIC_API_KEY is exactly the owner's own key", () => {
    const s = settingsWith([{ modelAccess: "api-key", secrets: [{ name: "anthropic-api-key", secret: ref("k0") }] }, { secrets: [{ name: "github", secret: ref("g1") }] }]);
    const ana = s.people[0]!;
    expect(auditModelAccess(s, ana, agent({ ANTHROPIC_API_KEY: ref("k0") }))).toEqual([]);
    expect(auditModelAccess(s, ana, agent({ ANTHROPIC_API_KEY: "sk-typed-in" })).join()).toContain("own anthropic-api-key key");
    expect(auditModelAccess(s, ana, agent({ ANTHROPIC_API_KEY: ref("other") })).join()).toContain("own anthropic-api-key key");
  });

  it("never lets an agent use another person's key", () => {
    const s = settingsWith([{ modelAccess: "subscription" }, { secrets: [{ name: "github", secret: ref("g1") }] }]);
    expect(auditModelAccess(s, s.people[0]!, agent({ GITHUB_TOKEN: ref("g1") })).join()).toContain("another person's key");
  });

  it("the Claude rules apply only to Claude agents (other tools bring their own access)", () => {
    const s = settingsWith([{}]);
    expect(auditModelAccess(s, s.people[0]!, agent({}, "codex_local"))).toEqual([]);
    expect(auditModelAccess(s, s.people[0]!, agent({ OPENAI_API_KEY: ref("own") }, "codex_local"))).toEqual([]);
  });

  it("another person's key is refused for every kind of agent, not only Claude", () => {
    const s = settingsWith([{}, { secrets: [{ name: "openai", secret: ref("o1") }, { name: "github", secret: ref("g1") }] }]);
    for (const adapter of ["codex_local", "cursor", "gemini_local", "opencode_local"]) {
      const problems = auditModelAccess(s, s.people[0]!, agent({ OPENAI_API_KEY: ref("o1"), GITHUB_TOKEN: ref("g1") }, adapter));
      expect(problems).toEqual(["the agent's OPENAI_API_KEY is another person's key", "the agent's GITHUB_TOKEN is another person's key"]);
    }
    // A Claude agent with no access chosen yet is told both things.
    expect(auditModelAccess(s, s.people[0]!, agent({ GITHUB_TOKEN: ref("g1") })).join()).toMatch(/no Claude access chosen.*another person's key/);
  });
});

describe("parseSettings: model access", () => {
  it("api-key needs the person's own key", () => {
    const r = parseSettings({ people: [{ email: "a@example.com", agentId: "a", timezone: "UTC", handoverStartHour: 1, handoverBudgetCapCents: 1, modelAccess: "api-key" }] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors[0]).toContain("needs the person's own key named anthropic-api-key");
  });

  it("never one shared account: one API key cannot belong to two people", () => {
    const shared = [{ name: "anthropic-api-key", secret: ref("same") }];
    const r = parseSettings({
      people: [
        { email: "a@example.com", agentId: "a", timezone: "UTC", handoverStartHour: 1, handoverBudgetCapCents: 1, modelAccess: "api-key", secrets: shared },
        { email: "b@example.com", agentId: "b", timezone: "UTC", handoverStartHour: 1, handoverBudgetCapCents: 1, modelAccess: "api-key", secrets: shared },
      ],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors).toContain("people[1].secrets: anthropic-api-key is already another person's key (never one shared account)");
  });
});

describe("Aurora's code never reads, copies or logs Claude login files", () => {
  // Every source file Aurora runs. The only allowed mention checks that Paperclip's own
  // user has no login file at all (vt-check), without opening it.
  const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
  const files = (dir: string): string[] =>
    readdirSync(dir).flatMap((f) => {
      const p = path.join(dir, f);
      if (f === "node_modules" || f === "dist") return [];
      return statSync(p).isDirectory() ? files(p) : [p];
    });
  const sources = [...files(path.join(ROOT, "plugin/src")), ...files(path.join(ROOT, "email-service/src")), ...files(path.join(ROOT, "deploy"))];
  it.each(sources.map((f) => [path.relative(ROOT, f)]))("%s", (rel) => {
    const text = readFileSync(path.join(ROOT, rel), "utf8");
    const mentions = text.split("\n").filter((l) => /\.credentials\.json|\.claude\/|CLAUDE_CONFIG_DIR/.test(l));
    const allowed = mentions.filter((l) => rel === "deploy/bin/vt-check" && /\[ -e "\$PCDATA\/\.claude\/\.credentials\.json" \]/.test(l));
    expect(mentions.filter((l) => !allowed.includes(l))).toEqual([]);
  });
});
