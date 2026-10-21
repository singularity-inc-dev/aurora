/**
 * Tiny in-memory stand-in for ctx.db that understands only the SQL this plugin
 * writes (task_events, night_runs, and the cost_events sum). The real SQL is
 * exercised against Paperclip's Postgres by scripts/integration-test.sh.
 */
type Row = Record<string, unknown>;

export interface FakeDb {
  namespace: string;
  tables: { task_events: Row[]; night_runs: Row[] };
  costs: Array<{ company_id: string; agent_id: string; cost_cents: number; occurred_at: Date }>;
  query<T = Row>(sql: string, params?: unknown[]): Promise<T[]>;
  execute(sql: string, params?: unknown[]): Promise<{ rowCount: number }>;
}

const KEYS = { task_events: ["task_id"], night_runs: ["company_id", "owner", "night_date"] } as const;

function tableOf(sql: string): "task_events" | "night_runs" {
  return sql.includes("night_runs") ? "night_runs" : "task_events";
}

/** Parse `col = $n` / `col = COALESCE(col, $n)` pairs into [column, value]. */
function assignments(clause: string, params: unknown[]): Array<[string, unknown, boolean]> {
  const out: Array<[string, unknown, boolean]> = [];
  for (const m of clause.matchAll(/(\w+)\s*=\s*(COALESCE\(\w+,\s*)?\$(\d+)/g)) out.push([m[1]!, params[Number(m[3]) - 1], Boolean(m[2])]);
  return out;
}

function matches(row: Row, where: string, params: unknown[]): boolean {
  for (const [col, value] of assignments(where, params)) if (String(row[col]) !== String(value)) return false;
  const inList = /(\w+) IN \(([^)]*)\)/.exec(where);
  if (inList) {
    const allowed = inList[2]!.split(",").map((s) => s.trim().replace(/'/g, ""));
    if (!allowed.includes(String(row[inList[1]!]))) return false;
  }
  return true;
}

export function createFakeDb(namespace = "ns"): FakeDb {
  const tables = { task_events: [] as Row[], night_runs: [] as Row[] };
  const costs: FakeDb["costs"] = [];
  return {
    namespace,
    tables,
    costs,
    async query<T>(sql: string, params: unknown[] = []): Promise<T[]> {
      if (sql.includes("cost_events")) {
        const [companyId, agentId, since] = params as [string, string, string];
        const spent = costs
          .filter((c) => c.company_id === companyId && c.agent_id === agentId && c.occurred_at >= new Date(since))
          .reduce((sum, c) => sum + c.cost_cents, 0);
        return [{ spent } as T];
      }
      const table = tables[tableOf(sql)];
      const where = sql.split(/\bWHERE\b/)[1]?.split(/\bORDER BY\b|\bLIMIT\b/)[0] ?? "";
      let rows = table.filter((r) => matches(r, where, params));
      if (/ORDER BY night_date DESC/.test(sql)) rows = rows.sort((a, b) => String(b.night_date).localeCompare(String(a.night_date)));
      const limit = /LIMIT (\d+)/.exec(sql);
      if (limit) rows = rows.slice(0, Number(limit[1]));
      return rows.map((r) => ({ ...r })) as T[];
    },
    async execute(sql: string, params: unknown[] = []) {
      const name = tableOf(sql);
      const table = tables[name];
      if (/^\s*INSERT/i.test(sql)) {
        const cols = /\(([^)]*)\)\s*VALUES/.exec(sql)![1]!.split(",").map((c) => c.trim());
        const values = /VALUES\s*\(([^)]*)\)/.exec(sql)![1]!.split(",").map((v) => v.trim());
        const row: Row = { task_ids: "[]", current_index: -1, current_attempt: 0 };
        cols.forEach((c, i) => {
          const v = values[i]!;
          row[c] = v.startsWith("$") ? params[Number(v.slice(1)) - 1] : v.replace(/'/g, "");
        });
        const exists = table.some((r) => KEYS[name].every((k) => r[k] === row[k]));
        if (exists) return { rowCount: 0 };
        table.push(row);
        return { rowCount: 1 };
      }
      const [setPart, wherePart] = sql.split(/\bWHERE\b/) as [string, string];
      let count = 0;
      for (const row of table) {
        if (!matches(row, wherePart, params)) continue;
        for (const [col, value, coalesce] of assignments(setPart.split(/\bSET\b/)[1]!, params)) {
          if (coalesce && row[col] != null) continue;
          row[col] = value;
        }
        count += 1;
      }
      return { rowCount: count };
    },
  };
}
