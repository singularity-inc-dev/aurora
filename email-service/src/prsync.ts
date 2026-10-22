import type { GithubClient } from "./github.ts";
import type { PluginApi } from "./paperclip.ts";

/**
 * Pull requests that wait for review: ask GitHub whether each one was merged
 * or closed, and tell the plugin. Open ones stay in the next morning's email.
 */
export async function syncPullRequests(api: PluginApi, github: GithubClient, log: (msg: string) => void = () => {}): Promise<number> {
  const { repo, pullRequests } = await api.waitingPullRequests();
  if (!repo) return 0;
  let changed = 0;
  for (const pr of pullRequests) {
    try {
      const s = await github.status(repo, pr);
      if (s.state === "open") continue;
      await api.pullRequestUpdate(pr.taskId, s.state, s.mergeSha);
      changed += 1;
      log(`pull request #${pr.number} was ${s.state} on GitHub`);
    } catch (err) {
      log(`could not check pull request #${pr.number}: ${err instanceof Error ? err.message : "error"}`);
    }
  }
  return changed;
}
