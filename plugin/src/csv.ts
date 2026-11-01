/** One CSV cell. Cells that a spreadsheet would run as a formula get a leading apostrophe. */
export function cell(v: unknown): string {
  let s = v === null || v === undefined ? "" : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Header and rows as CSV text (CRLF line ends, as spreadsheets expect). */
export function csvText(header: readonly string[], rows: ReadonlyArray<readonly unknown[]>): string {
  return `${[header, ...rows].map((r) => r.map(cell).join(",")).join("\r\n")}\r\n`;
}
