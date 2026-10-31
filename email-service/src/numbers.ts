/**
 * The pilot's numbers from the event log (thin version 1, piece F).
 * Usage: node src/numbers.ts [file.csv]
 * Writes the measurement sheet as CSV (to the file, or to standard output) and
 * prints the team's measures. Run on the server as `sudo vt-numbers`.
 */
import { writeFileSync } from "node:fs";
import { loadConfig } from "./config.ts";
import { paperclipApi } from "./paperclip.ts";

type Measures = Record<string, number | null>;
const [file] = process.argv.slice(2);
const api = paperclipApi(loadConfig());
const csv = await api.numbersCsv();
const n = (await api.numbers()) as { team: Measures; owners: Array<Measures & { owner: string }> };
if (file) writeFileSync(file, csv, { mode: 0o600 });
else process.stdout.write(csv);

const show = (v: number | null | undefined, unit = "") => (v === null || v === undefined ? "n/a" : `${v}${unit}`);
const pct = (v: number | null | undefined) => (v === null || v === undefined ? "n/a" : `${Math.round(v * 100)}%`);
const line = (who: string, m: Measures) =>
  `${who}: ${m.workOrders} work orders in ${m.handovers} handovers; yield ${pct(m.handoverYield)} (${m.accepted} approved, ${m.rejected} rejected, ${m.blocked} blocked, ${m.failed} failed, ${m.undecided} undecided); ` +
  `minutes to approve ${show(m.minutesToApprove)}; decisions per handback ${show(m.decisionsPerHandback)}; overlaps caught before ${m.overlapsCaughtBefore}; conflicts found after ${m.conflictsFoundAfter}`;
console.error(line("Team", n.team));
for (const o of n.owners) console.error(line(o.owner, o));
if (file) console.error(`Measurement sheet written to ${file}.`);
