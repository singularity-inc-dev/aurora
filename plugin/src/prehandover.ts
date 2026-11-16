import { areaOwners, claimsOverlap, ownerNames, type OwnerRule } from "./claims.js";
import type { Person } from "./config.js";

/** Hardy asks each owner at most this many questions before a handover (spec, step 5). */
export const MAX_QUESTIONS = 3;

export interface ProposedWork {
  title: string;
  claims: string[];
}

/** A task of another owner that still holds its claims: proposed and not yet decided. */
export interface OpenClaim {
  taskId: string;
  owner: string;
  title: string;
  claims: string[];
}

/** Owner areas from the repository's CODEOWNERS file, and the files the repository has. */
export interface Areas {
  rules: OwnerRule[];
  /** Paths of files (not folders) at the repository's head: a file has nothing below it. */
  files: ReadonlySet<string>;
  /** Where the rules came from, for the owner's note. */
  source: string;
}

export type Overlap =
  | { kind: "area"; claim: string; keeper: Person; rule: OwnerRule }
  | { kind: "claim"; claim: string; keeper: Person; other: OpenClaim; otherClaim: string };

export type Verdict = { title: string; claims: string[]; overlap: Overlap | null };

/**
 * The pre-handover check for one owner's proposal (thin version 1, piece D).
 *
 * A task keeps its place unless one of its claims reaches into another team
 * member's CODEOWNERS area, or into files another owner's open task already
 * claimed. Then the other owner keeps those files and the task moves to their
 * agent as a board ticket: the area owner first, otherwise the earlier claim.
 * Tasks already proposed are never changed by a later proposal.
 */
export function preHandoverCheck(
  proposer: Person,
  people: readonly Person[],
  tasks: readonly ProposedWork[],
  openClaims: readonly OpenClaim[],
  areas: Areas | null,
): Verdict[] {
  const others = people.filter((p) => p.email !== proposer.email);
  const isFile = (claim: string) => areas?.files.has(claim) ?? false;
  return tasks.map((task) => ({ title: task.title, claims: task.claims, overlap: areaOverlap(task) ?? claimOverlap(task) }));

  function areaOverlap(task: ProposedWork): Overlap | null {
    if (!areas) return null;
    for (const claim of task.claims) {
      const names = areaOwners(areas.rules, claim, isFile(claim));
      // A co-owner of the area may change it.
      if (names.some((n) => ownerNames(n, proposer))) continue;
      const keeper = others.find((p) => names.some((n) => ownerNames(n, p)));
      if (!keeper) continue; // nobody on the team owns it
      const rule = [...areas.rules]
        .reverse()
        .find((r) => r.owners.some((n) => ownerNames(n, keeper)) && claimsOverlap(r.pattern, claim, { bIsFile: isFile(claim) }))!;
      return { kind: "area", claim, keeper, rule };
    }
    return null;
  }

  function claimOverlap(task: ProposedWork): Overlap | null {
    for (const other of openClaims) {
      if (other.owner === proposer.email) continue;
      const keeper = others.find((p) => p.email === other.owner);
      if (!keeper) continue;
      for (const claim of task.claims) {
        const otherClaim = other.claims.find((c) => claimsOverlap(claim, c, { aIsFile: isFile(claim), bIsFile: isFile(c) }));
        if (otherClaim) return { kind: "claim", claim, keeper, other, otherClaim };
      }
    }
    return null;
  }
}

function why(o: Overlap): string {
  return o.kind === "area"
    ? `\`${o.claim}\` is in ${o.keeper.email}'s area (CODEOWNERS line ${o.rule.line})`
    : `\`${o.claim}\` overlaps \`${o.otherClaim}\`, claimed by ${o.keeper.email}'s task "${o.other.title}"`;
}

/** Why a moved task is now the keeper's ticket, for its description. */
export function movedTicketNote(proposer: Person, v: Verdict & { overlap: Overlap }): string {
  return (
    `Moved here by the pre-handover check: ${proposer.email}'s agent proposed this, but ${why(v.overlap)}. ` +
    `It waits in backlog until ${v.overlap.keeper.email} approves it in a handover plan.\n\nClaims: ${v.claims.map((c) => `\`${c}\``).join(", ")}`
  );
}

/**
 * The owner's questions about their plan: at most three. Past the third, the
 * rest are folded into the last one.
 */
export function ownerQuestions(moved: ReadonlyArray<{ verdict: Verdict & { overlap: Overlap }; ticket: string }>): string[] {
  const ask = (m: (typeof moved)[number]) =>
    `"${m.verdict.title}": ${why(m.verdict.overlap)}. It went to ${m.verdict.overlap.keeper.email}'s agent as ${m.ticket} and will not run in your handover. Is that right?`;
  if (moved.length <= MAX_QUESTIONS) return moved.map(ask);
  const rest = moved.slice(MAX_QUESTIONS - 1);
  return [
    ...moved.slice(0, MAX_QUESTIONS - 1).map(ask),
    `${rest.length} more tasks reach into other owners' files and went to their agents instead: ${rest.map((m) => `"${m.verdict.title}" (${m.ticket}, ${m.verdict.overlap.keeper.email})`).join("; ")}. Is that right?`,
  ];
}
