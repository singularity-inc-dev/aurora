import { describe, expect, it, vi } from "vitest";
import type { PluginSecretsClient } from "@paperclipai/plugin-sdk";
import { parseSettings, type PluginSettings } from "../src/config.js";
import { resolveOwnerSecret, SecretAccessDenied, selectOwnerSecret } from "../src/secrets.js";

function settings(): PluginSettings {
  const result = parseSettings({
    people: [
      {
        email: "ana@example.com",
        agentId: "agent-ana",
        timezone: "Europe/London",
        nightStartHour: 22,
        nightBudgetCapCents: 500,
        secrets: [
          { name: "github", secret: { type: "secret_ref", secretId: "sec-ana-gh" } },
          { name: "deploy", secret: { type: "secret_ref", secretId: "sec-ana-deploy" }, access: "read-write" },
        ],
      },
      {
        email: "bo@example.com",
        agentId: "agent-bo",
        timezone: "America/New_York",
        nightStartHour: 23,
        nightBudgetCapCents: 300,
        secrets: [{ name: "github", secret: { type: "secret_ref", secretId: "sec-bo-gh" } }],
      },
    ],
  });
  if (!result.ok) throw new Error(result.errors.join("; "));
  return result.settings;
}

describe("selectOwnerSecret", () => {
  it("returns only the owner's key, even when another person has the same name", () => {
    expect(selectOwnerSecret(settings(), { agentId: "agent-ana", name: "github", purpose: "read" }).secret.secretId).toBe(
      "sec-ana-gh",
    );
    expect(selectOwnerSecret(settings(), { agentId: "agent-bo", name: "github", purpose: "read" }).secret.secretId).toBe(
      "sec-bo-gh",
    );
  });

  it("refuses another person's key", () => {
    expect(() => selectOwnerSecret(settings(), { agentId: "agent-bo", name: "deploy", purpose: "read" })).toThrow(
      SecretAccessDenied,
    );
  });

  it("refuses an agent that is not bound to anyone", () => {
    expect(() => selectOwnerSecret(settings(), { agentId: "agent-x", name: "github", purpose: "read" })).toThrow(
      "agent is not bound to any person",
    );
  });

  it("keys are read-only by default", () => {
    expect(() => selectOwnerSecret(settings(), { agentId: "agent-ana", name: "github", purpose: "write" })).toThrow(
      'key "github" is read-only',
    );
  });

  it("allows write only when the key is marked read-write", () => {
    expect(selectOwnerSecret(settings(), { agentId: "agent-ana", name: "deploy", purpose: "write" }).access).toBe(
      "read-write",
    );
  });
});

describe("resolveOwnerSecret", () => {
  it("resolves the owner's ref through Paperclip with the company scope", async () => {
    const resolve = vi.fn(async () => "value");
    const client: PluginSecretsClient = { resolve };
    await resolveOwnerSecret(client, settings(), "co-1", { agentId: "agent-ana", name: "github", purpose: "read" });
    expect(resolve).toHaveBeenCalledWith({ type: "secret_ref", secretId: "sec-ana-gh" }, { companyId: "co-1" });
  });

  it("never calls Paperclip when access is denied", async () => {
    const resolve = vi.fn(async () => "value");
    await expect(
      resolveOwnerSecret({ resolve }, settings(), "co-1", { agentId: "agent-bo", name: "deploy", purpose: "read" }),
    ).rejects.toThrow(SecretAccessDenied);
    expect(resolve).not.toHaveBeenCalled();
  });
});
