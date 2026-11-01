/**
 * Tiny in-memory stand-in for ctx.db that understands only the SQL this plugin
 * writes. The real SQL is exercised against Paperclip's Postgres by
 * scripts/integration-test.sh.
 */
type Row = Record<string, unknown>;
type TableName = "task_events" | "handover_runs" | "briefings" | "link_actions" | "invites" | "pull_requests" | "overlaps" | "conflicts" | "handover_notes";

export interface FakeDb {
  namespace: string;
  tables: Record<TableName, Row[]>;
  costs: Array<{ company_id: string; agent_id: string; cost_cents: number; occurred_at: Date }>;
  query<T = Row>(sql: string, params?: unknown[]): Promise<T[]>;
  execute(sql: string, params?: unknown[]): Promise<{ rowCount: number }>;
}

const KEYS: Record<TableName, string[]> = {
  task_events: ["task_id"],
  handover_runs: ["company_id", "owner", "handover_key"],
  briefings: ["company_id", "owner", "handover_key"],
  link_actions: ["id"],
  invites: ["id"],
  pull_requests: ["task_id"],
  overlaps: ["id"],
  conflicts: ["company_id", "task_a", "task_b", "head_a", "head_b"],
  handover_notes: ["id"],
};
const DEFAULTS: Record<TableName, Row> = {
  task_events: {},
  handover_runs: { task_ids: "[]", current_index: -1, current_attempt: 0, kind: "scheduled" },
  briefings: { status: "pending", items: "[]", notes: "[]", conflicts: "[]", shared_files: "[]" },
  link_actions: { state: "new" },
  invites: { state: "new", attempts: 0 },
  pull_requests: { state: "waiting" },
  overlaps: {},
  conflicts: {},
  handover_notes: { claims: "[]", done_when: "" },
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
  const tables: Record<TableName, Row[]> = { task_events: [], handover_runs: [], briefings: [], link_actions: [], invites: [], pull_requests: [], overlaps: [], conflicts: [], handover_notes: [] };
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
      if (/ORDER BY created_at DESC/.test(sql)) rows = rows.reverse(); // rows are kept in insertion order
      else if (/ORDER BY created_at\b/.test(sql)) rows = [...rows];
      else if (/ORDER BY handover_key DESC/.test(sql)) rows = rows.sort((a, b) => String(b.handover_key).localeCompare(String(a.handover_key)));
      else if (/ORDER BY handover_key/.test(sql)) rows = rows.sort((a, b) => String(a.handover_key).localeCompare(String(b.handover_key)));
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
