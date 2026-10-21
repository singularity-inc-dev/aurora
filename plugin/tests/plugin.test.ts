import { describe, expect, it } from "vitest";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import { pluginManifestV1Schema } from "@paperclipai/shared";
import manifest from "../src/manifest.js";
import plugin from "../src/worker.js";

const config = {
  people: [
    {
      email: "ana@example.com",
      agentId: "agent-ana",
      timezone: "Europe/London",
      nightStartHour: 22,
      nightBudgetCapCents: 500,
      secrets: [{ name: "github", secret: { type: "secret_ref", secretId: "sec-ana-gh" } }],
    },
  ],
};

describe("manifest", () => {
  it("passes Paperclip's own manifest validator", () => {
    const result = pluginManifestV1Schema.safeParse(manifest);
    expect(result.success, JSON.stringify(result.error?.issues)).toBe(true);
  });

  it("asks for no merge, deploy, send, delete or spend capabilities", () => {
    expect(manifest.capabilities).toEqual(["secrets.read-ref"]);
  });
});

describe("worker", () => {
  it("lists configured people without exposing secret refs", async () => {
    const harness = createTestHarness({ manifest, config });
    await plugin.definition.setup(harness.ctx);
    const data = await harness.getData<{ ok: boolean; people: unknown[] }>("people");
    expect(data.ok).toBe(true);
    expect(data.people).toEqual([
      {
        email: "ana@example.com",
        agentId: "agent-ana",
        timezone: "Europe/London",
        nightStartHour: 22,
        maxTasksPerNight: 3,
        nightBudgetCapCents: 500,
        keyNames: [{ name: "github", access: "read-only" }],
      },
    ]);
    expect(JSON.stringify(data)).not.toContain("sec-ana-gh");
  });

  it("validates config through onValidateConfig", async () => {
    expect(await plugin.definition.onValidateConfig!(config)).toEqual({ ok: true });
    const bad = await plugin.definition.onValidateConfig!({
      people: [config.people[0], { ...config.people[0], email: "bo@example.com" }],
    });
    expect(bad.ok).toBe(false);
  });
});
