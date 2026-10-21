import type { JsonSchema } from "@paperclipai/plugin-sdk";

export const DEFAULT_MAX_TASKS_PER_NIGHT = 3;
export const MAX_PEOPLE = 10;

export type SecretAccess = "read-only" | "read-write";

/** Shared Paperclip secret reference shape. Never a raw secret value. */
export interface SecretRef {
  type: "secret_ref";
  secretId: string;
  version?: number | "latest";
}

export interface PersonSecret {
  name: string;
  secret: SecretRef;
  access: SecretAccess;
}

export interface Person {
  email: string;
  agentId: string;
  timezone: string;
  nightStartHour: number;
  maxTasksPerNight: number;
  nightBudgetCapCents: number;
  secrets: PersonSecret[];
}

export interface PluginSettings {
  people: Person[];
}

/**
 * Operator-editable settings. Paperclip renders this as the plugin settings form.
 * `format: "secret-ref"` renders a secret picker that stores a secret_ref object
 * (PLUGIN_SPEC.md §19.8), so raw keys never live in plugin config.
 */
export const instanceConfigSchema: JsonSchema = {
  type: "object",
  required: ["people"],
  properties: {
    people: {
      type: "array",
      title: "People",
      description: "One row per teammate. Each person gets exactly one personal agent.",
      maxItems: MAX_PEOPLE,
      items: {
        type: "object",
        required: ["email", "agentId", "timezone", "nightStartHour", "nightBudgetCapCents"],
        properties: {
          email: { type: "string", title: "Email", format: "email", minLength: 3 },
          agentId: { type: "string", title: "Agent id", minLength: 1 },
          timezone: { type: "string", title: "Timezone (IANA, e.g. Europe/London)", minLength: 1 },
          nightStartHour: { type: "integer", title: "Night start hour (0-23)", minimum: 0, maximum: 23 },
          maxTasksPerNight: {
            type: "integer",
            title: "Max tasks per night",
            minimum: 1,
            maximum: 10,
            default: DEFAULT_MAX_TASKS_PER_NIGHT,
          },
          nightBudgetCapCents: {
            type: "integer",
            title: "Night budget cap (US cents)",
            minimum: 0,
          },
          secrets: {
            type: "array",
            title: "Keys this person's agent may use",
            items: {
              type: "object",
              required: ["name", "secret"],
              properties: {
                name: { type: "string", title: "Name", minLength: 1 },
                secret: { type: "object", title: "Secret", format: "secret-ref" },
                access: {
                  type: "string",
                  title: "Access",
                  enum: ["read-only", "read-write"],
                  default: "read-only",
                },
              },
            },
          },
        },
      },
    },
  },
};

export type ParseResult = { ok: true; settings: PluginSettings } | { ok: false; errors: string[] };

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isValidTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

function parseSecretRef(value: unknown): SecretRef | null {
  if (!isRecord(value) || value.type !== "secret_ref") return null;
  if (typeof value.secretId !== "string" || value.secretId.length === 0) return null;
  const ref: SecretRef = { type: "secret_ref", secretId: value.secretId };
  if (value.version === "latest" || (typeof value.version === "number" && Number.isInteger(value.version))) {
    ref.version = value.version;
  }
  return ref;
}

/**
 * Validate raw config and apply defaults. Error messages name fields only and
 * never echo values, so a misplaced secret can't leak into logs or the UI.
 */
export function parseSettings(raw: unknown): ParseResult {
  const errors: string[] = [];
  if (!isRecord(raw) || !Array.isArray(raw.people)) {
    return { ok: false, errors: ["people: must be a list"] };
  }
  if (raw.people.length > MAX_PEOPLE) errors.push(`people: at most ${MAX_PEOPLE} people`);

  const people: Person[] = [];
  const seenAgents = new Set<string>();
  const seenEmails = new Set<string>();

  raw.people.forEach((entry, i) => {
    const at = `people[${i}]`;
    if (!isRecord(entry)) {
      errors.push(`${at}: must be an object`);
      return;
    }
    const email = typeof entry.email === "string" ? entry.email.trim().toLowerCase() : "";
    if (!EMAIL_RE.test(email)) errors.push(`${at}.email: must be a valid email`);
    else if (seenEmails.has(email)) errors.push(`${at}.email: already used by another person`);
    else seenEmails.add(email);

    const agentId = typeof entry.agentId === "string" ? entry.agentId.trim() : "";
    if (!agentId) errors.push(`${at}.agentId: required`);
    else if (seenAgents.has(agentId)) errors.push(`${at}.agentId: already bound to another person`);
    else seenAgents.add(agentId);

    const timezone = typeof entry.timezone === "string" ? entry.timezone : "";
    if (!timezone || !isValidTimezone(timezone)) errors.push(`${at}.timezone: must be an IANA timezone`);

    const nightStartHour = entry.nightStartHour;
    if (!Number.isInteger(nightStartHour) || (nightStartHour as number) < 0 || (nightStartHour as number) > 23) {
      errors.push(`${at}.nightStartHour: must be a whole number 0-23`);
    }

    const maxTasksPerNight = entry.maxTasksPerNight ?? DEFAULT_MAX_TASKS_PER_NIGHT;
    if (!Number.isInteger(maxTasksPerNight) || (maxTasksPerNight as number) < 1 || (maxTasksPerNight as number) > 10) {
      errors.push(`${at}.maxTasksPerNight: must be a whole number 1-10`);
    }

    const nightBudgetCapCents = entry.nightBudgetCapCents;
    if (!Number.isInteger(nightBudgetCapCents) || (nightBudgetCapCents as number) < 0) {
      errors.push(`${at}.nightBudgetCapCents: must be a whole number of cents, 0 or more`);
    }

    const secrets: PersonSecret[] = [];
    const seenNames = new Set<string>();
    const rawSecrets = entry.secrets ?? [];
    if (!Array.isArray(rawSecrets)) {
      errors.push(`${at}.secrets: must be a list`);
    } else {
      rawSecrets.forEach((s, j) => {
        const sat = `${at}.secrets[${j}]`;
        if (!isRecord(s)) {
          errors.push(`${sat}: must be an object`);
          return;
        }
        const name = typeof s.name === "string" ? s.name.trim() : "";
        if (!name) errors.push(`${sat}.name: required`);
        else if (seenNames.has(name)) errors.push(`${sat}.name: duplicate name for this person`);
        else seenNames.add(name);

        const ref = parseSecretRef(s.secret);
        if (!ref) errors.push(`${sat}.secret: must be a Paperclip secret reference`);

        const access = s.access ?? "read-only";
        if (access !== "read-only" && access !== "read-write") {
          errors.push(`${sat}.access: must be read-only or read-write`);
        }
        if (name && ref && (access === "read-only" || access === "read-write")) {
          secrets.push({ name, secret: ref, access });
        }
      });
    }

    people.push({
      email,
      agentId,
      timezone,
      nightStartHour: nightStartHour as number,
      maxTasksPerNight: maxTasksPerNight as number,
      nightBudgetCapCents: nightBudgetCapCents as number,
      secrets,
    });
  });

  return errors.length > 0 ? { ok: false, errors } : { ok: true, settings: { people } };
}

export function findPersonByAgent(settings: PluginSettings, agentId: string): Person | undefined {
  return settings.people.find((p) => p.agentId === agentId);
}
