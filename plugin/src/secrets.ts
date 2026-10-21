import type { PluginSecretsClient } from "@paperclipai/plugin-sdk";
import { findPersonByAgent, type PersonSecret, type PluginSettings } from "./config.js";

export class SecretAccessDenied extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SecretAccessDenied";
  }
}

export interface SecretRequest {
  agentId: string;
  name: string;
  /** Write access must be asked for explicitly; keys default to read-only. */
  purpose: "read" | "write";
}

/**
 * Pick the key an agent may use. Only keys listed under that agent's own owner
 * are visible; another person's key with the same name is never returned.
 */
export function selectOwnerSecret(settings: PluginSettings, req: SecretRequest): PersonSecret {
  const owner = findPersonByAgent(settings, req.agentId);
  if (!owner) throw new SecretAccessDenied("agent is not bound to any person");
  const entry = owner.secrets.find((s) => s.name === req.name);
  if (!entry) throw new SecretAccessDenied(`owner has no key named "${req.name}"`);
  if (req.purpose === "write" && entry.access !== "read-write") {
    throw new SecretAccessDenied(`key "${req.name}" is read-only`);
  }
  return entry;
}

/**
 * Resolve the key value at call time. The value is returned to the caller only;
 * never log it, store it, or put it in an error message (PLUGIN_SPEC.md §22).
 */
export async function resolveOwnerSecret(
  secrets: PluginSecretsClient,
  settings: PluginSettings,
  companyId: string,
  req: SecretRequest,
): Promise<string> {
  const entry = selectOwnerSecret(settings, req);
  return secrets.resolve(entry.secret, { companyId });
}
