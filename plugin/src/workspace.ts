/** Branch names for task worktrees. Paperclip renders the template per issue. */
export const TASK_BRANCH_TEMPLATE = "vt/{{issue.identifier}}-{{slug}}";

/**
 * Issue-level execution workspace settings (shared `IssueExecutionWorkspaceSettings`):
 * every task gets its own isolated git worktree on its own branch, created by
 * Paperclip when the agent starts work on the ticket.
 */
export function taskWorkspaceSettings(): Record<string, unknown> {
  return {
    mode: "isolated_workspace",
    workspaceStrategy: {
      type: "git_worktree",
      branchTemplate: TASK_BRANCH_TEMPLATE,
    },
  };
}
