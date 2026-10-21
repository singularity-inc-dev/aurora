import type { PluginCapability } from "@paperclipai/plugin-sdk";

/**
 * Capabilities this plugin must never request. Each one is a route between agents
 * that bypasses the board, or an action agents must never get (merge, deploy,
 * send, delete, spend). Checked by a unit test against the manifest.
 */
export const FORBIDDEN_CAPABILITIES: readonly PluginCapability[] = [
  "agent.sessions.create",
  "agent.sessions.send",
  "agent.sessions.list",
  "agent.sessions.close",
  "agents.invoke",
  "agents.managed",
  "agents.pause",
  "agents.resume",
  "issues.wakeup",
  "events.emit",
  "approvals.respond",
  "access.members.write",
  "access.invites.write",
  "authorization.grants.write",
  "authorization.policies.write",
  "skills.managed",
  "http.outbound",
];

/** The fields of a Paperclip agent this audit needs (subset of the SDK `Agent`). */
export interface AgentRouteFacts {
  id: string;
  companyId: string;
  role: string;
  status: string;
  permissions: { canCreateAgents?: boolean; canCreateSkills?: boolean } & Record<string, unknown>;
}

/**
 * Paperclip already refuses agent-to-agent wakeups ("Agent can only invoke itself").
 * The remaining side doors are agent permissions: an agent that can create agents
 * could spawn an unbound helper, one that can create skills changes shared company
 * state, and a CEO-role agent can change permissions. Returns plain-English problems.
 */
export function auditAgentRoutes(agent: AgentRouteFacts | null, companyId: string): string[] {
  if (!agent) return ["agent not found"];
  const problems: string[] = [];
  if (agent.companyId !== companyId) problems.push("agent belongs to another company");
  if (agent.status === "terminated") problems.push("agent is terminated");
  if (agent.role === "ceo") problems.push("agent has the CEO role, which can change permissions");
  if (agent.permissions?.canCreateAgents !== false) problems.push("agent can create other agents (turn off canCreateAgents)");
  if (agent.permissions?.canCreateSkills !== false) problems.push("agent can create shared skills (turn off canCreateSkills)");
  return problems;
}
