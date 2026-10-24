import { MAX_TASKS_PER_HANDOVER, type Person } from "./config.js";
import { MAX_CLAIMS_PER_TASK, normalizeClaim } from "./claims.js";
import { MAX_DESCRIPTION_LENGTH, MAX_TITLE_LENGTH } from "./handoff.js";

/** Every task lists the files and folders it may change (its claims, piece D). */
export type ProposedTask = ({ issueId: string } | { title: string; description: string }) & { claims: string[] };

export class ProposalRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProposalRefused";
  }
}

/** Validate an agent's handover proposal: 1 to min(person's limit, 3) tasks, each with its claims. */
export function parseProposal(params: unknown, person: Person): ProposedTask[] {
  const raw = (params as { tasks?: unknown } | null)?.tasks;
  if (!Array.isArray(raw) || raw.length === 0) throw new ProposalRefused("propose at least one task");
  const limit = Math.min(person.maxTasksPerHandover, MAX_TASKS_PER_HANDOVER);
  if (raw.length > limit) throw new ProposalRefused(`propose at most ${limit} tasks`);

  const seen = new Set<string>();
  return raw.map((entry, i): ProposedTask => {
    const t = (typeof entry === "object" && entry !== null ? entry : {}) as Record<string, unknown>;
    const claims = parseClaims(t.claims, i);
    const issueId = typeof t.issueId === "string" ? t.issueId.trim() : "";
    if (issueId) {
      if (seen.has(issueId)) throw new ProposalRefused(`task ${i + 1}: ticket listed twice`);
      seen.add(issueId);
      return { issueId, claims };
    }
    const title = typeof t.title === "string" ? t.title.trim() : "";
    const description = typeof t.description === "string" ? t.description.trim() : "";
    if (!title) throw new ProposalRefused(`task ${i + 1}: needs a title or an issueId`);
    if (title.length > MAX_TITLE_LENGTH) throw new ProposalRefused(`task ${i + 1}: title is too long`);
    if (description.length > MAX_DESCRIPTION_LENGTH) throw new ProposalRefused(`task ${i + 1}: description is too long`);
    return { title, description, claims };
  });
}

function parseClaims(raw: unknown, i: number): string[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new ProposalRefused(`task ${i + 1}: list the files and folders it may change (claims), e.g. ["src/ui/", "README.md"]`);
  }
  if (raw.length > MAX_CLAIMS_PER_TASK) throw new ProposalRefused(`task ${i + 1}: at most ${MAX_CLAIMS_PER_TASK} claims`);
  const claims = new Set<string>();
  for (const c of raw) {
    const claim = normalizeClaim(c);
    if (!claim) throw new ProposalRefused(`task ${i + 1}: claim ${JSON.stringify(c)} must be a path inside the repository ("*", "?" and "**" allowed)`);
    claims.add(claim);
  }
  return [...claims];
}
