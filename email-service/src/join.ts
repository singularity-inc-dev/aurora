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

/**
 * One invite link creates: the person's Paperclip account (in the company),
 * their one personal agent with safe defaults, and their row in the plugin
 * settings. The plugin decides whether the invite is usable (signed, not
 * expired, not used); the first request uses it up.
 */
export async function join(plugin: PluginApi, board: BoardApi, person: PersonApi, token: string, form: JoinForm): Promise<JoinOutcome> {
  const claim = await plugin.claimInvite(token, form.timezone);
  if (!claim.ok) return { ok: false, status: claim.status, message: claim.message };
  const { inviteId, email, timezone, defaults } = claim.plan;
  let step = "creating your account";
  try {
    const paperclipInvite = await board.createHumanInvite();
    const session = await person.signUp({ email, password: form.password, name: form.name });
    step = "adding you to the company";
    await person.acceptInvite(session.cookie, paperclipInvite);
    step = "creating your agent";
    const agentId = await board.createAgent({
      name: `${form.name}'s night agent`.slice(0, 120),
      adapterType: defaults.agentAdapterType,
      adapterConfig: defaults.agentAdapterConfig,
      budgetMonthlyCents: defaults.agentMonthlyBudgetCents,
    });
    step = "saving your settings";
    await serialized(async () => {
      const config = await board.getPluginConfig();
      const people = Array.isArray(config.people) ? (config.people as Array<Record<string, unknown>>) : [];
      if (people.some((p) => String(p.email ?? "").toLowerCase() === email)) throw new PaperclipError(409, "this person is already in the settings");
      await board.savePluginConfig({
        ...config,
        people: [
          ...people,
          {
            email,
            agentId,
            timezone,
            nightStartHour: defaults.nightStartHour,
            maxTasksPerNight: defaults.maxTasksPerNight,
            nightBudgetCapCents: defaults.nightBudgetCapCents,
            secrets: [],
          },
        ],
      });
    });
    const done = await plugin.finishInvite(inviteId, { ok: true, agentId, userId: session.userId });
    if (!done.ok) throw new PaperclipError(500, done.message);
    return { ok: true, status: "joined", message: `Welcome! Your account (${email}) and your night agent are ready.`, email };
  } catch (err) {
    const reason = err instanceof PaperclipError ? err.message : "unexpected error";
    await plugin.finishInvite(inviteId, { ok: false, message: `failed while ${step}: ${reason}` }).catch(() => undefined);
    return { ok: false, status: "failed", message: `Something went wrong while ${step} (${reason}). This link is now used up; please ask for a new one.` };
  }
}
