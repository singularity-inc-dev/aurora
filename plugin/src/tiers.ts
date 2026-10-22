/**
 * Action tiers (CLAUDE.md M4). Every action the system can take is listed once.
 * - automatic: the plugin does it on its own.
 * - needs-tap: only a signed link can do it (the task owner's morning-email
 *   link, or the invited person's own invite link).
 * - never: nothing in this system may do it.
 */
export type Tier = "automatic" | "needs-tap" | "never";

export const ACTION_TIERS = {
  "attach-checks-report": "automatic",
  "block-task": "automatic",
  "retry-task": "automatic",
  "pause-agent-at-budget-cap": "automatic",
  "send-morning-briefing": "automatic",
  "record-event": "automatic",
  "sync-pull-request-status": "automatic",
  "merge-task": "needs-tap",
  "reject-task": "needs-tap",
  // Approve with GitHub: push the task branch, open a pull request, squash-merge it
  // (branch protection decides; a blocked merge waits for review).
  "publish-to-github": "needs-tap",
  "join-from-invite": "needs-tap",
  deploy: "never",
  "push-to-base-branch-directly": "never",
  "force-push": "never",
  "bypass-branch-protection": "never",
  "delete-branch": "never",
  "delete-ticket": "never",
  "send-external-message": "never",
  spend: "never",
} as const satisfies Record<string, Tier>;

export type ActionName = keyof typeof ACTION_TIERS;

export class TierRefused extends Error {}

/** Throws unless `action` is in exactly the tier the caller is acting under. */
export function assertTier(action: string, tier: Tier): void {
  const actual = (ACTION_TIERS as Record<string, Tier>)[action];
  if (!actual) throw new TierRefused(`unknown action "${action}"`);
  if (actual === "never") throw new TierRefused(`"${action}" is never allowed`);
  if (actual !== tier) throw new TierRefused(`"${action}" is a ${actual} action`);
}

export function actionsIn(tier: Tier): string[] {
  return Object.entries(ACTION_TIERS)
    .filter(([, t]) => t === tier)
    .map(([a]) => a);
}
