import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ensureTaskRow, recordChecks, recordHandoff } from "../src/eventlog.js";
import manifest from "../src/manifest.js";

/** Same derivation as Paperclip's `derivePluginDatabaseNamespace` (server plugin-database.js). */
function namespaceFor(pluginKey: string, slug: string): string {
  const hash = createHash("sha256").update(pluginKey).digest("hex").slice(0, 10);
  return `plugin_${slug}_${hash}`;
}

function fakeDb() {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  return {
    calls,
    db: {
      namespace: "ns",
      async execute(sql: string, params: unknown[] = []) {
        calls.push({ sql, params });
        return { rowCount: 1 };
      },
      async query() {
        return [];
      },
    },
  };
}

describe("event log", () => {
  it("migration targets the namespace Paperclip derives for this plugin", () => {
    const ns = namespaceFor(manifest.id, manifest.database!.namespaceSlug!);
    const sql = readFileSync(new URL("../migrations/001_task_events.sql", import.meta.url), "utf8");
    const schemas = [...sql.matchAll(/"([a-z0-9_]+)"\./g)].map((m) => m[1]);
    expect(new Set(schemas)).toEqual(new Set([ns]));
  });

  it("migration has every event-log field from CLAUDE.md", () => {
    const sql = readFileSync(new URL("../migrations/001_task_events.sql", import.meta.url), "utf8");
    for (const col of [
      "task_id", "owner", "agent", "task_kind", "proposed_at", "approved_at", "started_at",
      "finished_at", "checks_result", "outcome", "reject_reason", "handed_off_to",
    ]) expect(sql).toContain(col);
  });

  it("writes one statement per call with every $n placeholder bound", async () => {
    const { db, calls } = fakeDb();
    const row = { taskId: "t1", companyId: "co", owner: "ana@example.com", agent: "a1", taskKind: "handoff" };
    await ensureTaskRow(db, row);
    await recordHandoff(db, row, "bo@example.com");
    await recordChecks(db, "t1", "passed", "abc123");
    for (const c of calls) {
      expect(c.sql).toContain('"ns".task_events');
      const placeholders = new Set([...c.sql.matchAll(/\$(\d+)/g)].map((m) => Number(m[1])));
      expect(placeholders.size).toBe(c.params.length);
    }
  });
});
