import { parseCodeowners } from "./claims.js";
import { git } from "./git.js";
import type { Areas } from "./prehandover.js";

/** Where GitHub looks for CODEOWNERS, in its order. */
export const CODEOWNERS_PATHS = [".github/CODEOWNERS", "CODEOWNERS", "docs/CODEOWNERS"];

/**
 * Owner areas at a commit of the project's repository: the committed CODEOWNERS
 * file (never the working folder, which an agent may have changed) and the list
 * of files there. Throws when the repository cannot be read: the caller fails closed.
 */
export async function readAreas(cwd: string, ref = "HEAD"): Promise<{ areas: Areas; notes: string[] }> {
  const commit = (await git(cwd, ["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`])).trim();
  const files = new Set((await git(cwd, ["ls-tree", "-r", "-z", "--name-only", commit])).split("\0").filter(Boolean));
  const source = CODEOWNERS_PATHS.find((p) => files.has(p));
  if (!source) {
    return { areas: { rules: [], files, source: "none" }, notes: ["No CODEOWNERS file in the repository, so owner areas are unknown; only claims were compared."] };
  }
  const { rules, skipped } = parseCodeowners(await git(cwd, ["show", `${commit}:${source}`]));
  const notes = skipped.length ? [`${source}: line(s) ${skipped.join(", ")} could not be read and were left out.`] : [];
  return { areas: { rules, files, source }, notes };
}
