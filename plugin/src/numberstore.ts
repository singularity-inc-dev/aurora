import type { PluginContext } from "@paperclipai/plugin-sdk";
import { computeNumbers, type Numbers } from "./numbers.js";

/** At most this many work orders get their ticket title looked up per request. */
const MAX_TITLES = 500;

/** Read the event log's tables for one company and compute the pilot's numbers. */
export async function loadNumbers(ctx: PluginContext, companyId: string): Promise<Numbers> {
  const all = (table: string) => ctx.db.query(`SELECT * FROM "${ctx.db.namespace}".${table} WHERE company_id = $1`, [companyId]);
  const [runs, events, briefings, actions, overlaps, conflicts] = await Promise.all(
    ["handover_runs", "task_events", "briefings", "link_actions", "overlaps", "conflicts"].map(all),
  );
  const first = computeNumbers({ runs: runs!, events: events!, briefings: briefings!, actions: actions!, overlaps: overlaps!, conflicts: conflicts!, titles: new Map() });
  const titles = new Map<string, string>();
  for (const row of first.rows.slice(0, MAX_TITLES)) {
    const issue = await ctx.issues.get(row.taskId, companyId).catch(() => null);
    if (issue) titles.set(row.taskId, issue.identifier ? `${issue.identifier} ${issue.title}` : issue.title);
  }
  return computeNumbers({ runs: runs!, events: events!, briefings: briefings!, actions: actions!, overlaps: overlaps!, conflicts: conflicts!, titles });
}
