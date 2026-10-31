import { MODEL_KEY_NAME, type Person, type PluginSettings } from "./config.js";
import type { AgentIsolationFacts } from "./isolation.js";

/** Settings through which Claude Code picks up an account: never set for a subscription. */
export const CLAUDE_AUTH_ENV = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN"] as const;

const secretIdOf = (binding: unknown): string | null => {
  const b = binding as { type?: unknown; secretId?: unknown } | null;
  return b && typeof b === "object" && b.type === "secret_ref" && typeof b.secretId === "string" ? b.secretId : null;
};

/**
 * Each owner's agent uses that owner's own Claude access (spec gap 2, owner's
 * answer 5): their subscription, signed in through Claude Code's own login on
 * their agent's user (nothing about it is in Paperclip), or their own API key,
 * a Paperclip secret listed under that person only. Never one shared account.
 * The audit reads only the agent's settings; it never reads a login or a key.
 */
export function auditModelAccess(settings: PluginSettings, person: Person, agent: AgentIsolationFacts): string[] {
  if (agent.adapterType !== "claude_local") return [];
  if (!person.modelAccess) return ["no Claude access chosen for this person yet: their own subscription or API key (vt-model-access)"];
  const env = (agent.adapterConfig?.env ?? {}) as Record<string, unknown>;
  const problems: string[] = [];
  const given = CLAUDE_AUTH_ENV.filter((k) => env[k] !== undefined && env[k] !== null && env[k] !== "");
  if (person.modelAccess === "subscription") {
    if (given.length > 0) problems.push(`the agent is given ${given.join(", ")}, but this owner uses their own subscription (signed in on their agent)`);
  } else {
    const own = person.secrets.find((s) => s.name === MODEL_KEY_NAME);
    if (!own || secretIdOf(env.ANTHROPIC_API_KEY) !== own.secret.secretId) {
      problems.push(`the agent's ANTHROPIC_API_KEY must be this owner's own ${MODEL_KEY_NAME} key`);
    }
    const others = given.filter((k) => k !== "ANTHROPIC_API_KEY");
    if (others.length > 0) problems.push(`the agent is also given ${others.join(", ")}`);
  }
  // No setting of the agent may point at another person's key.
  const othersKeys = new Set(settings.people.filter((p) => p.email !== person.email).flatMap((p) => p.secrets.map((s) => s.secret.secretId)));
  for (const [name, binding] of Object.entries(env)) {
    const id = secretIdOf(binding);
    if (id && othersKeys.has(id)) problems.push(`the agent's ${name} is another person's key`);
  }
  return problems;
}
