/**
 * Tiny in-memory stand-in for ctx.db that understands only the SQL this plugin
 * writes. The real SQL is exercised against Paperclip's Postgres by
 * scripts/integration-test.sh.
 */
type Row = Record<string, unknown>;
type TableName = "task_events" | "night_runs" | "briefings" | "link_actions" | "invites" | "pull_requests";

export interface FakeDb {
  namespace: string;
  tables: Record<TableName, Row[]>;
  costs: Array<{ company_id: string; agent_id: string; cost_cents: number; occurred_at: Date }>;
  query<T = Row>(sql: string, params?: unknown[]): Promise<T[]>;
  execute(sql: string, params?: unknown[]): Promise<{ rowCount: number }>;
}

const KEYS: Record<TableName, string[]> = {
  task_events: ["task_id"],
  night_runs: ["company_id", "owner", "night_date"],
  briefings: ["company_id", "owner", "night_date"],
  link_actions: ["id"],
  invites: ["id"],
  pull_requests: ["task_id"],
};
const DEFAULTS: Record<TableName, Row> = {
  task_events: {},
  night_runs: { task_ids: "[]", current_index: -1, current_attempt: 0 },
  briefings: { status: "pending", items: "[]", notes: "[]" },
  link_actions: { state: "new" },
  invites: { state: "new" },
  pull_requests: { state: "waiting" },
};

function tableOf(sql: string): TableName {
  const m = /"\w+"\.(\w+)/.exec(sql);
  return m![1] as TableName;
}

/** Value of a SQL operand: $n, 'literal', NULL, number or now(). */
function operand(token: string, params: unknown[]): unknown {
  const t = token.trim();
  if (t.startsWith("$")) return params[Number(t.slice(1)) - 1];
  if (t.startsWith("'")) return t.slice(1, -1);
  if (/^null$/i.test(t)) return null;
  if (/^now\(\)$/i.test(t)) return new Date().toISOString();
  return Number(t);
}

const CONDITION = /(\w+)\s*(?:=\s*(\$\d+|'[^']*'|NULL|-?\d+)|(IS NULL)|IN \(([^)]*)\))/gi;

function matches(row: Row, where: string, params: unknown[]): boolean {
  for (const m of where.matchAll(CONDITION)) {
    const [, col, eq, isNull, inList] = m;
    const value = row[col!];
    if (isNull) {
      if (value !== null && value !== undefined) return false;
    } else if (inList !== undefined) {
      if (!inList.split(",").map((s) => s.trim().replace(/'/g, "")).includes(String(value))) return false;
    } else if (String(value) !== String(operand(eq!, params))) return false;
  }
  return true;
}

function applySet(row: Row, set: string, params: unknown[]): void {
  for (const part of set.split(/,(?![^(]*\))/)) {
    const m = /(\w+)\s*=\s*(.+)/.exec(part.trim());
    if (!m) continue;
    const [, col, expr] = m;
    const coalesce = /^COALESCE\(\w+,\s*(\$\d+)\)$/i.exec(expr!.trim());
    if (coalesce) {
      if (row[col!] == null) row[col!] = operand(coalesce[1]!, params);
    } else row[col!] = operand(expr!, params);
  }
}

export function createFakeDb(namespace = "ns"): FakeDb {
  const tables: Record<TableName, Row[]> = { task_events: [], night_runs: [], briefings: [], link_actions: [], invites: [], pull_requests: [] };
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
      const where = sql.split(/\bWHERE\b/)[1]?.split(/\bORDER BY\b|\bLIMIT\b/)[0] ?? "";
      let rows = tables[tableOf(sql)].filter((r) => matches(r, where, params));
      if (/ORDER BY night_date DESC/.test(sql)) rows = rows.sort((a, b) => String(b.night_date).localeCompare(String(a.night_date)));
      else if (/ORDER BY night_date/.test(sql)) rows = rows.sort((a, b) => String(a.night_date).localeCompare(String(b.night_date)));
      const limit = /LIMIT (\d+)/.exec(sql);
      if (limit) rows = rows.slice(0, Number(limit[1]));
      return rows.map((r) => ({ ...r })) as T[];
    },
    async execute(sql: string, params: unknown[] = []) {
      const name = tableOf(sql);
      const table = tables[name];
      if (/^\s*INSERT/i.test(sql)) {
        const cols = /\(([^)]*)\)\s*VALUES/.exec(sql)![1]!.split(",").map((c) => c.trim());
        const values = /VALUES\s*\(([^)]*)\)/.exec(sql)![1]!.split(",");
        const row: Row = { ...DEFAULTS[name] };
        cols.forEach((c, i) => (row[c] = operand(values[i]!, params)));
        if (table.some((r) => KEYS[name].every((k) => String(r[k]) === String(row[k])))) return { rowCount: 0 };
        table.push(row);
        return { rowCount: 1 };
      }
      const [setPart, wherePart] = sql.split(/\bWHERE\b/) as [string, string];
      let count = 0;
      for (const row of table) {
        if (!matches(row, wherePart, params)) continue;
        applySet(row, setPart.split(/\bSET\b/)[1]!, params);
        count += 1;
      }
      return { rowCount: count };
    },
  };
}
