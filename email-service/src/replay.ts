/**
 * Save real handover tasks for the replay tool (evals).
 * Usage: node src/replay.ts save FILE [--limit N] [--include-undecided]
 * Asks the plugin to snapshot decided tasks from the event log (their inputs, the
 * commit they started from, what became of them) and writes them to FILE (mode 600).
 * The file holds ticket text, so treat it like the tickets themselves.
 * Run on the server as `sudo vt-replay save FILE`; run them with `vt-replay run`.
 */
import { writeFileSync } from "node:fs";
import { loadConfig } from "./config.ts";
import { paperclipApi, type PluginApi } from "./paperclip.ts";

export const TASKS_FORMAT = "vt-replay-tasks/1";

export async function save(api: Pick<PluginApi, "replaySave">, file: string, limit: number, includeUndecided: boolean, now = new Date()): Promise<string> {
  const r = await api.replaySave(limit, includeUndecided);
  writeFileSync(file, JSON.stringify({ format: TASKS_FORMAT, savedAt: now.toISOString(), tasks: r.tasks, checks: r.checks }, null, 2), { mode: 0o600 });
  const lines = [`Saved ${r.added} new task(s); ${r.tasks.length} task(s) are in ${file}.`];
  for (const s of r.skipped) lines.push(`Not saved: ${s.taskId}: ${s.reason}.`);
  if (r.tasks.length < 10) lines.push("Fewer than 10 tasks are saved. A comparison needs 10 to 20; save again once more tasks have been decided.");
  return lines.join("\n");
}

if (import.meta.main) {
  const [command, file, ...rest] = process.argv.slice(2);
  if (command !== "save" || !file) {
    console.error("Usage: vt-replay save FILE [--limit N] [--include-undecided]\n       vt-replay run --tasks FILE --repo DIR --baseline FILE --candidate FILE --agent-cmd 'COMMAND' ...");
    process.exit(2);
  }
  const li = rest.indexOf("--limit");
  const limit = li >= 0 ? Number(rest[li + 1]) : 20;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    console.error("--limit must be a whole number from 1 to 100");
    process.exit(2);
  }
  console.error(await save(paperclipApi(loadConfig()), file, limit, rest.includes("--include-undecided")));
}
