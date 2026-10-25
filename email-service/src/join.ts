import { isolatedAdapterConfig, type AgentBinding } from "./agentenv.ts";
import type { BoardApi, PersonApi, PluginApi } from "./paperclip.ts";
import { PaperclipError } from "./paperclip.ts";

export const MIN_PASSWORD = 12;
export const MAX_PASSWORD = 128;

export interface JoinForm {
  name: string;
  password: string;
  timezone: string | null;
}

export type JoinOutcome =
  | { ok: true; status: "joined"; message: string; email: string }
  | { ok: false; status: "invalid" | "expired" | "already-used" | "refused" | "needs-input" | "failed"; message: string };

/** Check what the person typed before the invite is used up. */
export function checkJoinForm(raw: { name?: string | null; password?: string | null; timezone?: string | null }): JoinForm | string {
  const name = (raw.name ?? "").replace(/\s+/g, " ").trim();
  const password = raw.password ?? "";
  if (name.length < 1 || name.length > 80) return "Please type your name (up to 80 characters).";
  if (password.length < MIN_PASSWORD || password.length > MAX_PASSWORD) return `Please choose a password of ${MIN_PASSWORD} to ${MAX_PASSWORD} characters.`;
  const timezone = (raw.timezone ?? "").trim() || null;
  return { name, password, timezone };
}

// New people are added one at a time, so two joins never overwrite each other's settings row.
let queue: Promise<unknown> = Promise.resolve();
function serialized<T>(fn: () => Promise<T>): Promise<T> {
  const next = queue.then(fn, fn);
  queue = next.catch(() => undefined);
  return next;
}

/** The person must fix what they typed (the invite stays usable). */
class NeedsInput extends Error {}

/** The new account, or (a later try) the account an earlier try made, if the password matches. */
async function accountFor(person: PersonApi, email: string, form: JoinForm): Promise<{ cookie: string; userId: string }> {
  try {
    return await person.signUp({ email, password: form.password, name: form.name });
  } catch (err) {
    if (!(err instanceof PaperclipError) || err.status !== 409) throw err;
  }
  try {
    return await person.signIn({ email, password: form.password });
  } catch (err) {
    if (err instanceof PaperclipError && err.status === 401) {
      throw new NeedsInput("An account with this email already exists (perhaps from an earlier try). Please type the same password you chose then.");
    }
    throw err;
  }
}

/** The agent an earlier try already made for this person, so a new try never makes a second one. */
async function earlierAgent(board: BoardApi, agent: AgentBinding | null, resumeAgentId: string | null): Promise<string | null> {
  // Each person's environment is their own (vt-invite made it for this invite), so it finds their agent even after a crash.
  if (agent) return board.findAgentByEnvironment(agent.agentEnvironmentId);
  if (!resumeAgentId) return null;
  try {
    const found = await board.getAgent(resumeAgentId);
    return found.status === "terminated" ? null : resumeAgentId;
  } catch (err) {
    if (err instanceof PaperclipError && err.status === 404) return null;
    throw err;
  }
}

/**
 * One invite link creates: the person's Paperclip account (in the company),
 * their one personal agent with safe defaults, and their row in the plugin
 * settings. The plugin decides whether the invite is usable (signed, not
 * expired, not used) and lets one try run at a time. Every step is safe to
 * repeat, so a try that fails halfway gives the invite back and the next try
 * reuses what the first one made.
 */
export async function join(plugin: PluginApi, board: BoardApi, person: PersonApi, token: string, form: JoinForm): Promise<JoinOutcome> {
  const claim = await plugin.claimInvite(token, form.timezone);
  if (!claim.ok) return { ok: false, status: claim.status, message: claim.message };
  const { inviteId, attempt, email, timezone, defaults, agent } = claim.plan;
  const resume = claim.plan.resume ?? { userId: null, agentId: null };
  let step = "creating your account";
  let userId: string | null = null;
  let agentId: string | null = null;
  try {
    const session = await accountFor(person, email, form);
    userId = session.userId;
    step = "adding you to the company";
    if (!(await board.isMember(session.userId))) {
      const paperclipInvite = await board.createHumanInvite();
      await person.acceptInvite(session.cookie, paperclipInvite).catch((err) => {
        // Joined in the meantime (a second tab): that is what this step wanted.
        if (!(err instanceof PaperclipError && err.status === 409)) throw err;
      });
    }
    step = "creating your agent";
    agentId = await earlierAgent(board, agent, resume.agentId);
    if (agentId) await board.lockAgent(agentId);
    else {
      agentId = await board.createAgent({
        name: `${form.name}'s agent`.slice(0, 120),
        adapterType: defaults.agentAdapterType,
        // In its own environment: the system user vt-invite made for this person (agent isolation).
        adapterConfig: agent ? isolatedAdapterConfig(defaults.agentAdapterType, defaults.agentAdapterConfig) : defaults.agentAdapterConfig,
        budgetMonthlyCents: defaults.agentMonthlyBudgetCents,
        defaultEnvironmentId: agent?.agentEnvironmentId ?? null,
      });
    }
    const newAgentId = agentId;
    step = "saving your settings";
    await serialized(async () => {
      const config = await board.getPluginConfig();
      const people = Array.isArray(config.people) ? (config.people as Array<Record<string, unknown>>) : [];
      const already = people.find((p) => String(p.email ?? "").toLowerCase() === email);
      if (already) {
        // Saved by an earlier try: nothing to do. Anyone else under this email is a conflict.
        if (already.agentId === newAgentId) return;
        throw new PaperclipError(409, "this person is already in the settings");
      }
      await board.savePluginConfig({
        ...config,
        people: [
          ...people,
          {
            email,
            agentId: newAgentId,
            ...(agent ? { agentEnvironmentId: agent.agentEnvironmentId, agentUser: agent.agentUser, checksKey: agent.checksKey } : {}),
            timezone,
            handoverStartHour: defaults.handoverStartHour,
            maxTasksPerHandover: defaults.maxTasksPerHandover,
            handoverBudgetCapCents: defaults.handoverBudgetCapCents,
            secrets: [],
          },
        ],
      });
    });
    const done = await plugin.finishInvite(inviteId, { ok: true, agentId: newAgentId, userId: session.userId, ...(attempt ? { attempt } : {}) });
    if (!done.ok) throw new PaperclipError(500, done.message);
    return { ok: true, status: "joined", message: `Welcome! Your account (${email}) and your agent are ready.`, email };
  } catch (err) {
    const reason = err instanceof NeedsInput ? err.message : err instanceof PaperclipError ? err.message : "unexpected error";
    const recorded = await plugin
      .finishInvite(inviteId, { ok: false, message: `failed while ${step}: ${reason}`, userId, agentId, ...(attempt ? { attempt } : {}) })
      .catch(() => null);
    // If the plugin could not be told, the invite comes back by itself after a few minutes.
    const retry = recorded?.retry !== false;
    if (err instanceof NeedsInput && retry) return { ok: false, status: "needs-input", message: err.message };
    return {
      ok: false,
      status: "failed",
      message: `Something went wrong while ${step} (${reason}). ${retry ? "Your invite link still works: please try again in a few minutes. What was already made is kept and reused." : "This link is now used up; please ask for a new one."}`,
    };
  }
}
