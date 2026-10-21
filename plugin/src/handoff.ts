import { findPersonByAgent, findPersonByEmail, type Person, type PluginSettings } from "./config.js";

export const MAX_TITLE_LENGTH = 200;
export const MAX_DESCRIPTION_LENGTH = 10_000;

export interface HandoffRequest {
  /** Teammate's email as configured in the plugin settings. */
  toEmail: string;
  /** Assign this existing ticket instead of creating a new one. */
  issueId?: string;
  title?: string;
  description?: string;
}

export type HandoffPlan =
  | { kind: "create"; from: Person; to: Person; title: string; description: string }
  | { kind: "assign"; from: Person; to: Person; issueId: string; note: string };

export class HandoffRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HandoffRefused";
  }
}

function asText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export function parseHandoffRequest(params: unknown): HandoffRequest {
  const p = (typeof params === "object" && params !== null ? params : {}) as Record<string, unknown>;
  const req: HandoffRequest = { toEmail: asText(p.toEmail) };
  const issueId = asText(p.issueId);
  if (issueId) req.issueId = issueId;
  const title = asText(p.title);
  if (title) req.title = title;
  const description = asText(p.description);
  if (description) req.description = description;
  return req;
}

/**
 * Decide what a hand-off may do. The only outcomes are "create a board ticket" or
 * "assign an existing ticket", and only to another configured teammate's agent.
 */
export function planHandoff(settings: PluginSettings, fromAgentId: string, req: HandoffRequest): HandoffPlan {
  const from = findPersonByAgent(settings, fromAgentId);
  if (!from) throw new HandoffRefused("calling agent is not bound to any person");
  if (!req.toEmail) throw new HandoffRefused("toEmail is required");
  const to = findPersonByEmail(settings, req.toEmail);
  if (!to) throw new HandoffRefused("toEmail is not a configured teammate");
  if (to.agentId === from.agentId) throw new HandoffRefused("cannot hand off to yourself");

  const description = req.description ?? "";
  if (description.length > MAX_DESCRIPTION_LENGTH) {
    throw new HandoffRefused(`description is longer than ${MAX_DESCRIPTION_LENGTH} characters`);
  }

  if (req.issueId) {
    return { kind: "assign", from, to, issueId: req.issueId, note: description };
  }
  const title = req.title ?? "";
  if (!title) throw new HandoffRefused("title is required to create a ticket");
  if (title.length > MAX_TITLE_LENGTH) throw new HandoffRefused(`title is longer than ${MAX_TITLE_LENGTH} characters`);
  return { kind: "create", from, to, title, description };
}

export function handoffDescription(plan: HandoffPlan & { kind: "create" }): string {
  const header = `Handed off by ${plan.from.email}'s agent to ${plan.to.email}'s agent via Vision and Tom.`;
  return plan.description ? `${header}\n\n${plan.description}` : header;
}
