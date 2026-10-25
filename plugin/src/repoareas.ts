import { codeownersTeams, parseCodeowners } from "./claims.js";
import { git } from "./git.js";
import type { Areas } from "./prehandover.js";

/** Where GitHub looks for CODEOWNERS, in its order. */
export const CODEOWNERS_PATHS = [".github/CODEOWNERS", "CODEOWNERS", "docs/CODEOWNERS"];

/**
 * Owner areas at a commit of the project's repository: the committed CODEOWNERS
 * file (never the working folder, which an agent may have changed) and the list
 * of files there. Throws when the repository cannot be read: the caller fails closed.
 */
/**
 * A clear warning for team entries: they match nobody, so the pre-handover
 * check cannot protect those areas until the admin lists people instead.
 */
export function teamWarning(source: string, teams: ReadonlyArray<{ team: string; lines: number[] }>): string | null {
  if (teams.length === 0) return null;
  const named = teams.map((t) => `${t.team} (line${t.lines.length > 1 ? "s" : ""} ${t.lines.join(", ")})`).join(", ");
  return (
    `WARNING: ${source} names GitHub team${teams.length > 1 ? "s" : ""} ${named}. ` +
    "Aurora cannot see who is in a team, so nobody is protected in those areas. " +
    "Ask your admin to list the people instead (their GitHub login, e.g. @ana, or their email), next to or instead of the team."
  );
}

export async function readAreas(cwd: string, ref = "HEAD"): Promise<{ areas: Areas; notes: string[]; teams: Array<{ team: string; lines: number[] }> }> {
  const commit = (await git(cwd, ["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`])).trim();
  const files = new Set((await git(cwd, ["ls-tree", "-r", "-z", "--name-only", commit])).split("\0").filter(Boolean));
  const source = CODEOWNERS_PATHS.find((p) => files.has(p));
  if (!source) {
    return { areas: { rules: [], files, source: "none" }, notes: ["No CODEOWNERS file in the repository, so owner areas are unknown; only claims were compared."], teams: [] };
  }
  const { rules, skipped } = parseCodeowners(await git(cwd, ["show", `${commit}:${source}`]));
  const teams = codeownersTeams(rules);
  const warning = teamWarning(source, teams);
  const notes = [...(warning ? [warning] : []), ...(skipped.length ? [`${source}: line(s) ${skipped.join(", ")} could not be read and were left out.`] : [])];
  return { areas: { rules, files, source }, notes, teams };
}
