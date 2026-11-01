import { describe, expect, it } from "vitest";
import { DEFAULT_MAX_TASKS_PER_HANDOVER, parseSettings, migrateLegacySettings } from "../src/config.js";

const ref = (id: string) => ({ type: "secret_ref", secretId: id });

function person(overrides: Record<string, unknown> = {}) {
  return {
    email: "ana@example.com",
    agentId: "agent-ana",
    timezone: "Europe/London",
    handoverStartHour: 22,
    handoverBudgetCapCents: 500,
    secrets: [{ name: "github", secret: ref("sec-ana-gh") }],
    ...overrides,
  };
}

describe("parseSettings", () => {
  it("accepts a valid person and applies defaults", () => {
    const result = parseSettings({ people: [person()] });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const p = result.settings.people[0]!;
    expect(p.maxTasksPerHandover).toBe(DEFAULT_MAX_TASKS_PER_HANDOVER);
    expect(p.secrets[0]!.access).toBe("read-only");
  });

  it("binds each agent to exactly one person", () => {
    const result = parseSettings({
      people: [person(), person({ email: "bo@example.com" })],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors).toContain("people[1].agentId: already bound to another person");
  });

  it("rejects the same email twice, case-insensitively", () => {
    const result = parseSettings({
      people: [person(), person({ email: "ANA@example.com", agentId: "agent-2" })],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors).toContain("people[1].email: already used by another person");
  });

  it.each([
    [{ email: "not-an-email" }, "people[0].email: must be a valid email"],
    [{ agentId: "" }, "people[0].agentId: required"],
    [{ timezone: "Mars/Olympus" }, "people[0].timezone: must be an IANA timezone"],
    [{ handoverStartHour: 24 }, "people[0].handoverStartHour: must be a whole number 0-23"],
    [{ handoverStartHour: 21.5 }, "people[0].handoverStartHour: must be a whole number 0-23"],
    [{ maxTasksPerHandover: 0 }, "people[0].maxTasksPerHandover: must be a whole number 1-3"],
    [{ maxTasksPerHandover: 4 }, "people[0].maxTasksPerHandover: must be a whole number 1-3"],
    [{ handoverBudgetCapCents: -1 }, "people[0].handoverBudgetCapCents: must be a whole number of cents, 0 or more"],
  ])("rejects bad field %o", (overrides, message) => {
    const result = parseSettings({ people: [person(overrides)] });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors).toContain(message);
  });

  it("rejects more than 10 people", () => {
    const people = Array.from({ length: 11 }, (_, i) =>
      person({ email: `p${i}@example.com`, agentId: `agent-${i}` }),
    );
    const result = parseSettings({ people });
    expect(result.ok).toBe(false);
  });

  it("requires keys to be Paperclip secret references, never raw values", () => {
    const result = parseSettings({
      people: [person({ secrets: [{ name: "github", secret: "ghp_plaintext_token_value" }] })],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors).toContain("people[0].secrets[0].secret: must be a Paperclip secret reference");
    expect(result.errors.join(" ")).not.toContain("ghp_plaintext_token_value");
  });

  it("rejects duplicate key names for one person", () => {
    const result = parseSettings({
      people: [
        person({
          secrets: [
            { name: "github", secret: ref("a") },
            { name: "github", secret: ref("b") },
          ],
        }),
      ],
    });
    expect(result.ok).toBe(false);
  });

  it("rejects missing people list", () => {
    expect(parseSettings({}).ok).toBe(false);
    expect(parseSettings(null).ok).toBe(false);
  });
});

describe("handover settings (stored under the old name night)", () => {
  const p = { email: "a@example.com", agentId: "a", timezone: "UTC", handoverStartHour: 22, handoverBudgetCapCents: 0 };
  it("uses safe defaults", () => {
    const r = parseSettings({ people: [p] });
    expect(r.ok && r.settings.handover).toEqual({ projectId: null, proposalLeadHours: 2, handoverLengthHours: 8, stepTimeoutMinutes: 60, maxRetries: 1 });
  });
  it("rejects out-of-range values", () => {
    const r = parseSettings({ people: [p], night: { stepTimeoutMinutes: 1, maxRetries: 9 } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors).toEqual(["handover.stepTimeoutMinutes: must be a whole number 5-480", "handover.maxRetries: must be a whole number 0-3"]);
  });
});

describe("settings saved under the old night-only names", () => {
  const old = {
    night: { projectId: "p1", nightLengthHours: 6 },
    invites: { nightStartHour: 21, nightBudgetCapCents: 100, maxTasksPerNight: 2 },
    people: [{ email: "ana@example.com", agentId: "a1", timezone: "UTC", nightStartHour: 23, nightBudgetCapCents: 400, maxTasksPerNight: 2 }],
  };

  it("still work, and say which old names they use", () => {
    const r = parseSettings(old);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.settings.handover).toMatchObject({ projectId: "p1", handoverLengthHours: 6 });
    expect(r.settings.people[0]).toMatchObject({ handoverStartHour: 23, handoverBudgetCapCents: 400, maxTasksPerHandover: 2 });
    expect(r.settings.invites).toMatchObject({ handoverStartHour: 21, handoverBudgetCapCents: 100, maxTasksPerHandover: 2 });
    expect(r.settings.legacyNames).toContain("people[0].nightStartHour");
    expect(r.settings.legacyNames).toContain("night");
  });

  it("migrate to the new names without losing anything (new names win)", () => {
    const { config, legacyNames } = migrateLegacySettings({ ...old, people: [{ ...old.people[0], handoverStartHour: 5 }] });
    expect(JSON.stringify(config)).not.toMatch(/night/i);
    expect((config as any).people[0]).toMatchObject({ handoverStartHour: 5, handoverBudgetCapCents: 400 });
    expect(legacyNames.length).toBeGreaterThan(0);
    expect(migrateLegacySettings(config).legacyNames).toEqual([]);
  });
});

describe("githubLogin (piece D: CODEOWNERS names people by login or email)", () => {
  const bo = (o: Record<string, unknown> = {}) => person({ email: "bo@example.com", agentId: "agent-bo", secrets: [], ...o });

  it("is optional, and a leading @ is dropped", () => {
    const r = parseSettings({ people: [person({ githubLogin: "@Ana-Dev" }), bo()] });
    expect(r.ok && r.settings.people.map((p) => p.githubLogin)).toEqual(["Ana-Dev", null]);
  });

  it("refuses something that is not a GitHub login, or one used twice", () => {
    const bad = parseSettings({ people: [person({ githubLogin: "ana dev" })] });
    expect(!bad.ok && bad.errors).toEqual(["people[0].githubLogin: must be a GitHub login"]);
    const twice = parseSettings({ people: [person({ githubLogin: "ana" }), bo({ githubLogin: "ANA" })] });
    expect(!twice.ok && twice.errors).toEqual(["people[1].githubLogin: already used by another person"]);
  });
});
