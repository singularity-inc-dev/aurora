import { sandboxLogin, type Person, type PluginSettings } from "./config.js";
import { auditModelAccess } from "./modelaccess.js";
import { auditAgentRoutes, type AgentRouteFacts } from "./routes.js";

/**
 * Adapters that run in the agent's own environment. This is Paperclip's own list
 * (REMOTE_MANAGED_ADAPTERS in @paperclipai/shared environment-support, checked by
 * tests/isolation.test.ts). Every other adapter always runs on the host as
 * Paperclip's own system user, whatever environment the agent names.
 */
export const ENVIRONMENT_ADAPTERS: readonly string[] = [
  "claude_local",
  "codex_local",
  "paperclip_runner",
  "cursor",
  "gemini_local",
  "grok_local",
  "kimi_local",
  "opencode_local",
  "pi_local",
];

/** The agent fields the isolation audit needs (subset of the SDK `Agent`). */
export interface AgentIsolationFacts extends AgentRouteFacts {
  adapterType: string;
  adapterConfig: Record<string, unknown>;
  defaultEnvironmentId?: string | null;
}

/**
 * Agent isolation (spec gap 1): the agent must run in its owner's own
 * environment, which the server tools create as an SSH login to a system user of
 * its own (it cannot read Paperclip's data, secrets or the link signing key).
 * The plugin cannot read environments, so it checks the binding; `vt-check` on
 * the server checks that each environment really is such a user.
 */
export function auditIsolation(settings: PluginSettings, person: Person, agent: AgentIsolationFacts | null): string[] {
  if (!settings.isolation.required) return [];
  if (!agent) return ["agent not found"];
  const problems: string[] = [];
  if (!ENVIRONMENT_ADAPTERS.includes(agent.adapterType)) {
    problems.push(`agent adapter "${agent.adapterType}" always runs as Paperclip's own system user (use one that runs in an environment, such as claude_local)`);
  }
  if (!person.agentEnvironmentId) {
    problems.push("this person has no environment of their own yet (agentEnvironmentId; set by vt-setup or the invite)");
  } else if (agent.defaultEnvironmentId !== person.agentEnvironmentId) {
    problems.push("agent does not run in its owner's own environment (its default environment must be the person's agentEnvironmentId)");
  }
  if ((settings.checks.testCommand || settings.checks.lintCommand) && settings.checks.sandbox && !sandboxLogin(settings, person)) {
    problems.push("checks cannot run as this person's agent user yet (agentUser and checksKey; set by vt-setup or the invite)");
  }
  // Paperclip runs Claude over SSH only with its CLI engine; with any other engine every run fails.
  if (agent.adapterType === "claude_local" && agent.adapterConfig?.engine !== "cli") {
    problems.push('Claude agents in an SSH environment need adapter setting engine "cli"');
  }
  return problems;
}

/** Settings-wide problems: with isolation required, test commands never run as Paperclip's own user. */
export function auditSettingsIsolation(settings: PluginSettings): string[] {
  if (!settings.isolation.required) return [];
  if ((settings.checks.testCommand || settings.checks.lintCommand) && !settings.checks.sandbox) {
    return ["test or lint commands are set but the checks sandbox is not (they would run as Paperclip's own user)"];
  }
  return [];
}

/** Everything that stops a person's agent from working: side doors (routes.ts), isolation and model access. */
export function agentProblems(settings: PluginSettings, person: Person, agent: AgentIsolationFacts | null, companyId: string): string[] {
  const routes = auditAgentRoutes(agent, companyId);
  if (!agent) return routes;
  return [...routes, ...auditIsolation(settings, person, agent), ...auditModelAccess(settings, person, agent)];
}
