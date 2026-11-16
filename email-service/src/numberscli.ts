/**
 * `vt-numbers`: print the raw counts, and optionally write the event log as CSV.
 *
 *   vt-numbers                       raw counts on the screen
 *   vt-numbers --events FILE         also write the event log (one row per task) to FILE
 *   vt-numbers --events -            event log CSV on standard output, counts on standard error
 *   vt-numbers FILE | --sheet FILE   also write the pilot's measurement sheet to FILE (the earlier command)
 *
 * Counts only: no percentages.
 */
import { writeFileSync } from "node:fs";
import { countsText } from "./counts.ts";
import { PaperclipError, type PluginApi } from "./paperclip.ts";

export interface CliIo {
  out(text: string): void;
  err(text: string): void;
  writeFile(file: string, text: string): void;
}

export const realIo: CliIo = {
  out: (t) => void process.stdout.write(t),
  err: (t) => void process.stderr.write(t),
  // The files hold names and reject reasons: owner-only.
  writeFile: (file, text) => writeFileSync(file, text, { mode: 0o600 }),
};

const USAGE = "Usage: vt-numbers [--events FILE|-] [--sheet FILE]\n";

export function parseArgs(argv: readonly string[]): { events: string | null; sheet: string | null; help: boolean } | string {
  const out = { events: null as string | null, sheet: null as string | null, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--help" || a === "-h") out.help = true;
    else if (a === "--events" || a === "--sheet") {
      const value = argv[++i];
      if (!value) return `${a} needs a file name`;
      out[a === "--events" ? "events" : "sheet"] = value;
    } else if (!a.startsWith("-") && out.sheet === null) out.sheet = a; // the earlier form: vt-numbers numbers.csv
    else return `I do not understand "${a}"`;
  }
  return out;
}

/** Returns the exit code. */
export async function runNumbers(api: PluginApi, argv: readonly string[], io: CliIo = realIo): Promise<number> {
  const args = parseArgs(argv);
  if (typeof args === "string") {
    io.err(`${args}\n${USAGE}`);
    return 2;
  }
  if (args.help) {
    io.out(USAGE);
    return 0;
  }
  try {
    const counts = countsText(await api.counts());
    // With "--events -" the CSV owns standard output, so the counts go to standard error.
    if (args.events === "-") io.err(counts);
    else io.out(counts);
    if (args.events === "-") io.out(await api.eventsCsv());
    else if (args.events) {
      io.writeFile(args.events, await api.eventsCsv());
      io.err(`Event log written to ${args.events}.\n`);
    }
    if (args.sheet) {
      io.writeFile(args.sheet, await api.numbersCsv());
      io.err(`Measurement sheet written to ${args.sheet}.\n`);
    }
    return 0;
  } catch (err) {
    if (err instanceof PaperclipError && err.status === 404) {
      io.err("The plugin on this server does not have the counts yet (it is older than 0.11.0). Run: sudo vt-update\n");
    } else {
      io.err(`Could not read the numbers: ${err instanceof Error ? err.message : "unknown error"}\n`);
    }
    return 1;
  }
}
