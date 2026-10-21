import { describe, expect, it } from "vitest";
import { DEFAULT_MAX_TASKS_PER_NIGHT, parseSettings } from "../src/config.js";

const ref = (id: string) => ({ type: "secret_ref", secretId: id });

function person(overrides: Record<string, unknown> = {}) {
  return {
    email: "ana@example.com",
    agentId: "agent-ana",
    timezone: "Europe/London",
    nightStartHour: 22,
    nightBudgetCapCents: 500,
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
    expect(p.maxTasksPerNight).toBe(DEFAULT_MAX_TASKS_PER_NIGHT);
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
    [{ nightStartHour: 24 }, "people[0].nightStartHour: must be a whole number 0-23"],
    [{ nightStartHour: 21.5 }, "people[0].nightStartHour: must be a whole number 0-23"],
    [{ maxTasksPerNight: 0 }, "people[0].maxTasksPerNight: must be a whole number 1-3"],
    [{ maxTasksPerNight: 4 }, "people[0].maxTasksPerNight: must be a whole number 1-3"],
    [{ nightBudgetCapCents: -1 }, "people[0].nightBudgetCapCents: must be a whole number of cents, 0 or more"],
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

describe("night settings", () => {
  const p = { email: "a@example.com", agentId: "a", timezone: "UTC", nightStartHour: 22, nightBudgetCapCents: 0 };
  it("uses safe defaults", () => {
    const r = parseSettings({ people: [p] });
    expect(r.ok && r.settings.night).toEqual({ projectId: null, proposalLeadHours: 2, nightLengthHours: 8, stepTimeoutMinutes: 60, maxRetries: 1 });
  });
  it("rejects out-of-range values", () => {
    const r = parseSettings({ people: [p], night: { stepTimeoutMinutes: 1, maxRetries: 9 } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors).toEqual(["night.stepTimeoutMinutes: must be a whole number 5-480", "night.maxRetries: must be a whole number 0-3"]);
  });
});
