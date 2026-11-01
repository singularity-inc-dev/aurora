import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { paperclipApi } from "../src/paperclip.ts";
import { save, TASKS_FORMAT } from "../src/replay.ts";

const cfg = { paperclipUrl: "http://pc", plugin: "p", companyId: "co", apiKey: "k", apiKeyFile: null } as never;

describe("vt-replay save", () => {
  it("writes the tasks and the gate settings to a file only its owner can read", async () => {
    const file = path.join(mkdtempSync(path.join(tmpdir(), "vt-rs-")), "tasks.json");
    const api = { replaySave: async () => ({ added: 2, skipped: [{ taskId: "t9", reason: "the ticket is gone, so its inputs are lost" }], tasks: [{ taskId: "t1" }], checks: { testCommand: "pnpm test" } }) };
    const text = await save(api, file, 20, false, new Date("2026-11-01T00:00:00Z"));
    const written = JSON.parse(readFileSync(file, "utf8"));
    expect(written).toEqual({ format: TASKS_FORMAT, savedAt: "2026-11-01T00:00:00.000Z", tasks: [{ taskId: "t1" }], checks: { testCommand: "pnpm test" } });
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(text).toContain("Saved 2 new task(s); 1 task(s)");
    expect(text).toContain("Not saved: t9: the ticket is gone");
    expect(text).toContain("Fewer than 10 tasks");
  });

  it("asks the plugin's board-only route with the company and the options", async () => {
    const seen: Array<{ url: string; method: string; body: unknown }> = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      seen.push({ url, method: init.method!, body: JSON.parse(String(init.body)) });
      return new Response(JSON.stringify({ added: 0, skipped: [], tasks: [], checks: {} }), { status: 200 });
    }) as unknown as typeof fetch;
    await paperclipApi(cfg, fetchImpl).replaySave(15, true);
    expect(seen).toEqual([{ url: "http://pc/api/plugins/p/api/replay/save", method: "POST", body: { companyId: "co", limit: 15, includeUndecided: true } }]);
  });
});
