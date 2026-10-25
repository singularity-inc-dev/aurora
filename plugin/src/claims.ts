/**
 * Claims (thin version 1, piece D): the folders and files a work order may change,
 * and the owner areas from the repository's CODEOWNERS file.
 *
 * A claim is a path relative to the repository root, with "/" between folders:
 * a file ("src/api/search.ts"), a folder ("src/ui/" or "src/ui"), or a pattern
 * with "*" (any characters in one name), "?" (one character) or "**" (any folders).
 * A claim always covers everything below it, as CODEOWNERS patterns do.
 *
 * The overlap test errs on the side of "they overlap": a false overlap costs the
 * owner one question, a missed one costs a merge conflict.
 */

export const MAX_CLAIMS_PER_TASK = 20;
export const MAX_CLAIM_LENGTH = 200;

/** A claim in its stored form: no leading "/", folders without a trailing "/". */
export function normalizeClaim(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  let s = raw.trim();
  if (!s || s.length > MAX_CLAIM_LENGTH) return null;
  // Not supported, so refused rather than misread: Windows separators, character classes, negation, escapes.
  if (/[\\\0\[\]!]/.test(s)) return null;
  s = s.replace(/^\/+/, "").replace(/\/+$/, "");
  if (!s) return null;
  const parts = s.split("/");
  if (parts.some((p) => p === "" || p === "." || p === "..")) return null;
  return parts.join("/");
}

/**
 * Pattern segments, ending in "**" (a claim covers everything below it) unless it
 * names a file the repository has: a file has nothing below it.
 */
function segments(pattern: string, isFile = false): string[] {
  const parts = pattern.split("/").filter(Boolean);
  if (!isFile && parts[parts.length - 1] !== "**") parts.push("**");
  // "**/**" is the same as "**".
  return parts.filter((p, i) => !(p === "**" && parts[i - 1] === "**"));
}

const isWild = (seg: string) => /[*?]/.test(seg);

function segmentRegex(seg: string): RegExp {
  const body = seg.replace(/[.+^${}()|]/g, "\\$&").replace(/\*/g, "[^/]*").replace(/\?/g, "[^/]");
  return new RegExp(`^${body}$`);
}

/** Can one folder or file name match both? Two patterns with wildcards are assumed to. */
function segmentsMeet(a: string, b: string): boolean {
  if (!isWild(a) && !isWild(b)) return a === b;
  if (isWild(a) && isWild(b)) return true;
  return isWild(a) ? segmentRegex(a).test(b) : segmentRegex(b).test(a);
}

function meet(a: string[], b: string[], i: number, j: number, seen: Set<string>): boolean {
  const key = `${i},${j}`;
  if (seen.has(key)) return false;
  seen.add(key);
  if (i === a.length && j === b.length) return true;
  if (a[i] === "**" && (meet(a, b, i + 1, j, seen) || (j < b.length && meet(a, b, i, j + 1, seen)))) return true;
  if (b[j] === "**" && (meet(a, b, i, j + 1, seen) || (i < a.length && meet(a, b, i + 1, j, seen)))) return true;
  if (i === a.length || j === b.length || a[i] === "**" || b[j] === "**") return false;
  return segmentsMeet(a[i]!, b[j]!) && meet(a, b, i + 1, j + 1, seen);
}

/**
 * Could some file be inside both claims (or patterns)? Without `aIsFile`/`bIsFile`
 * a plain path may be a folder too.
 */
export function claimsOverlap(a: string, b: string, opts: { aIsFile?: boolean; bIsFile?: boolean } = {}): boolean {
  return meet(segments(a, opts.aIsFile), segments(b, opts.bIsFile), 0, 0, new Set());
}

/**
 * Is every file of `inner` inside `outer`? Only answered "yes" when it is plainly
 * so: `outer` is a fixed folder ("src/ui"), or a fixed folder at any depth
 * ("**" + "/docs"), above the fixed start of `inner`.
 */
export function covers(outer: string, inner: string): boolean {
  let o = segments(outer).slice(0, -1);
  const anyDepth = o[0] === "**";
  if (anyDepth) o = o.slice(1);
  if (o.some(isWild)) return false;
  const fixed: string[] = [];
  for (const seg of segments(inner)) {
    if (isWild(seg)) break;
    fixed.push(seg);
  }
  // A fixed start must leave at least one name below the folder, or be the folder itself.
  for (let at = 0; at <= (anyDepth ? fixed.length - o.length : 0); at++) {
    if (o.length + at <= fixed.length && o.every((seg, i) => seg === fixed[at + i])) return true;
  }
  return false;
}

export interface OwnerRule {
  /** The pattern as a claim (see `codeownersPattern`). */
  pattern: string;
  /** Owners as written: "@login", "@org/team" or an email. Empty: nobody owns it. */
  owners: string[];
  line: number;
}

/**
 * A CODEOWNERS pattern in claim form. As in GitHub: a leading "/" or a "/" inside
 * anchors it to the root; otherwise it matches at any depth.
 */
export function codeownersPattern(raw: string): string | null {
  const anchored = raw.startsWith("/") || raw.replace(/\/+$/, "").includes("/");
  const claim = normalizeClaim(raw);
  if (!claim) return null;
  return anchored || claim.startsWith("**") ? claim : `**/${claim}`;
}

/** Parse a CODEOWNERS file. Lines it cannot read are listed, never guessed. */
export function parseCodeowners(text: string): { rules: OwnerRule[]; skipped: number[] } {
  const rules: OwnerRule[] = [];
  const skipped: number[] = [];
  text.split("\n").forEach((row, i) => {
    const line = row.replace(/(^|\s)#.*$/, "").trim();
    if (!line) return;
    const [raw, ...owners] = line.split(/\s+/);
    const pattern = raw === "*" ? "**" : codeownersPattern(raw!);
    if (!pattern) {
      skipped.push(i + 1);
      return;
    }
    rules.push({ pattern, owners, line: i + 1 });
  });
  return { rules, skipped };
}

/**
 * Every owner of any area a claim reaches into. In CODEOWNERS the last matching
 * rule wins, so a rule is passed over when a later rule plainly covers the whole claim.
 */
export function areaOwners(rules: readonly OwnerRule[], claim: string, claimIsFile = false): string[] {
  const owners = new Set<string>();
  rules.forEach((rule, i) => {
    if (!claimsOverlap(rule.pattern, claim, { bIsFile: claimIsFile })) return;
    if (rules.slice(i + 1).some((later) => covers(later.pattern, claim))) return;
    for (const o of rule.owners) owners.add(o);
  });
  return [...owners];
}

/** A GitHub team ("@org/team"). Aurora cannot see who is in a team, so a team never matches a person. */
export function isTeamEntry(entry: string): boolean {
  return /^@[^/\s]+\/\S+$/.test(entry);
}

/** Every team named in CODEOWNERS, with the lines that name it (in file order). */
export function codeownersTeams(rules: readonly OwnerRule[]): Array<{ team: string; lines: number[] }> {
  const teams = new Map<string, number[]>();
  for (const rule of rules) {
    for (const owner of rule.owners) {
      if (!isTeamEntry(owner)) continue;
      const lines = teams.get(owner) ?? [];
      if (!lines.includes(rule.line)) lines.push(rule.line);
      teams.set(owner, lines);
    }
  }
  return [...teams].map(([team, lines]) => ({ team, lines }));
}

/** Does a CODEOWNERS owner entry name this person (by email or GitHub login)? */
export function ownerNames(entry: string, person: { email: string; githubLogin?: string | null }): boolean {
  const e = entry.toLowerCase();
  if (e === person.email.toLowerCase()) return true;
  return !!person.githubLogin && e === `@${person.githubLogin.toLowerCase()}`;
}
