/**
 * Action tiers (CLAUDE.md M4). Every action the system can take is listed once.
 * - automatic: the plugin does it on its own.
 * - needs-tap: only the person concerned can do it, by a tap: the owner signed in
 *   to Paperclip (Hand over, Approve, Reject), or the invited person's own invite link.
 * - never: nothing in this system may do it.
 */
export type Tier = "automatic" | "needs-tap" | "never";

export const ACTION_TIERS = {
  "attach-checks-report": "automatic",
  "block-task": "automatic",
  "retry-task": "automatic",
  "pause-agent-at-budget-cap": "automatic",
  "send-handback-email": "automatic",
  "record-event": "automatic",
  "sync-pull-request-status": "automatic",
  "merge-task": "needs-tap",
  "reject-task": "needs-tap",
  // Approve with GitHub: push the task branch, open a pull request, squash-merge it
  // (branch protection decides; a blocked merge waits for review).
  "publish-to-github": "needs-tap",
  "join-from-invite": "needs-tap",
  // Hand over (now, or for the scheduled window): only the signed-in owner, on their own
  // page, with their own handover notes. The tap is the approval of exactly those tasks.
  "start-handover-now": "needs-tap",
  "queue-handover": "needs-tap",
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
