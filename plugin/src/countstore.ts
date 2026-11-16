import type { PluginContext } from "@paperclipai/plugin-sdk";
import { computeCounts, type RawCounts } from "./counts.js";
import { eventLogCsv } from "./eventlogcsv.js";
import { listFlagsForCompany } from "./flagstore.js";

const all = (ctx: PluginContext, table: string, companyId: string) => ctx.db.query(`SELECT * FROM "${ctx.db.namespace}".${table} WHERE company_id = $1`, [companyId]);

/** Raw counts for one company, from the plugin's own tables. */
export async function loadCounts(ctx: PluginContext, companyId: string): Promise<RawCounts> {
  const [events, briefings, conflicts, flags] = await Promise.all([
    all(ctx, "task_events", companyId),
    all(ctx, "briefings", companyId),
    all(ctx, "conflicts", companyId),
    listFlagsForCompany(ctx.db, companyId),
  ]);
  return computeCounts({ events, briefings, conflicts, flags });
}

/** The event log (one row per task, with run flags) as CSV text. */
export async function loadEventLogCsv(ctx: PluginContext, companyId: string): Promise<string> {
  const [events, flags] = await Promise.all([all(ctx, "task_events", companyId), listFlagsForCompany(ctx.db, companyId)]);
  return eventLogCsv(events, flags);
}
