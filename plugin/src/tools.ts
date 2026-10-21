import type { PluginToolDeclaration } from "@paperclipai/plugin-sdk";

export const TOOL_HANDOFF = "handoff_to_teammate";
export const TOOL_RUN_CHECKS = "run_checks";

export const HANDOFF_TOOL: PluginToolDeclaration = {
  name: TOOL_HANDOFF,
  displayName: "Hand off to a teammate",
  description:
    "Give work to a teammate's agent by creating a board ticket assigned to them, or by assigning one of your own tickets to them. This is the only way to pass work to another agent.",
  parametersSchema: {
    type: "object",
    properties: {
      toEmail: { type: "string", description: "The teammate's email, as set in the plugin settings." },
      title: { type: "string", description: "Title for a new ticket (required unless issueId is given)." },
      description: { type: "string", description: "What the teammate needs to know." },
      issueId: { type: "string", description: "Assign this existing ticket of yours instead of creating one." },
    },
    required: ["toEmail"],
  },
};

export const RUN_CHECKS_TOOL: PluginToolDeclaration = {
  name: TOOL_RUN_CHECKS,
  displayName: "Run the checks gate",
  description:
    "Run tests, lint, the change-size limit and the secret scan in this ticket's own worktree. The report is attached to the ticket.",
  parametersSchema: {
    type: "object",
    properties: { issueId: { type: "string", description: "The ticket whose worktree to check." } },
    required: ["issueId"],
  },
};
