import type { GithubClient } from "./github.ts";
import type { PluginApi } from "./paperclip.ts";

/**
 * Approvals interrupted between the owner's tap and the report back (the
 * service stopped mid-publish; spec gap 27). The plugin lists the ones stuck
 * for longer than `olderThanMinutes`; each is finished on GitHub (or given up,
 * which brings the task back in the next email) and reported to the plugin.
 * Approvals this process is still publishing are left alone.
 */
export async function recoverStuckApprovals(
  api: PluginApi,
  github: GithubClient,
  inFlight: ReadonlySet<string>,
  olderThanMinutes: number,
  log: (msg: string) => void = () => {},
): Promise<number> {
  let recovered = 0;
  for (const stuck of await api.stuckApprovals(olderThanMinutes)) {
    if (inFlight.has(stuck.actionId)) continue;
    try {
      const result = await github.resume(stuck.publish);
      const outcome = await api.recoverApproval(stuck.actionId, olderThanMinutes, result);
      recovered += 1;
      log(`finished an interrupted approval: ${result.result} (${outcome.status})`);
    } catch (err) {
      // GitHub or Paperclip could not be asked: leave it for the next round.
      log(`could not finish an interrupted approval yet: ${err instanceof Error ? err.message : "error"}`);
    }
  }
  return recovered;
}
