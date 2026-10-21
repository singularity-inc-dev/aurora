import type { JsonSchema } from "@paperclipai/plugin-sdk";

export const DEFAULT_MAX_TASKS_PER_NIGHT = 3;
export const MAX_PEOPLE = 10;
export const DEFAULT_MAX_DIFF_LINES = 400;
export const DEFAULT_CHECK_TIMEOUT_SECONDS = 600;
/** Hard upper bound on tasks per agent per night (evening proposal of up to 3). */
export const MAX_TASKS_PER_NIGHT = 3;
export const DEFAULT_NIGHT: NightSettings = {
  projectId: null,
  proposalLeadHours: 2,
  nightLengthHours: 8,
  stepTimeoutMinutes: 60,
  maxRetries: 1,
};

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

/** Checks gate settings. Commands are set by the operator, never by agents. */
export interface ChecksSettings {
  testCommand: string | null;
  lintCommand: string | null;
  maxDiffLines: number;
  timeoutSeconds: number;
}

/** Night routine settings shared by everyone. */
export interface NightSettings {
  /** Project (with the repo) that night tasks are created in. */
  projectId: string | null;
  /** How many hours before a person's night start the evening plan opens. */
  proposalLeadHours: number;
  nightLengthHours: number;
  /** Time limit for one task (step) before it is retried or failed. */
  stepTimeoutMinutes: number;
  maxRetries: number;
}

/** Morning email links. Without these, no briefing is built (fail closed). */
export interface LinkSettings {
  /** Public address of the email service that serves the link pages. */
  baseUrl: string;
  /** Paperclip secret used to sign links. */
  signingSecret: SecretRef;
  expiresMinutes: number;
}

export const DEFAULT_LINK_EXPIRES_MINUTES = 24 * 60;

export interface PluginSettings {
  people: Person[];
  checks: ChecksSettings;
  night: NightSettings;
  links: LinkSettings | null;
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
    links: {
      type: "object",
      title: "Morning email links",
      properties: {
        baseUrl: { type: "string", title: "Email service address (e.g. https://approve.example.com)" },
        signingSecret: { type: "object", title: "Link signing key", format: "secret-ref" },
        expiresMinutes: {
          type: "integer",
          title: "Links expire after (minutes)",
          minimum: 1,
          maximum: 4320,
          default: DEFAULT_LINK_EXPIRES_MINUTES,
        },
      },
    },
    night: {
      type: "object",
      title: "Night routine",
      properties: {
        projectId: { type: "string", title: "Project for night tasks (its repo gets the worktrees)" },
        proposalLeadHours: { type: "integer", title: "Evening plan opens this many hours before night start", minimum: 1, maximum: 12, default: 2 },
        nightLengthHours: { type: "integer", title: "Night length (hours)", minimum: 1, maximum: 16, default: 8 },
        stepTimeoutMinutes: { type: "integer", title: "Time limit per task (minutes)", minimum: 5, maximum: 480, default: 60 },
        maxRetries: { type: "integer", title: "Retries after a time-out", minimum: 0, maximum: 3, default: 1 },
      },
    },
    checks: {
      type: "object",
      title: "Checks gate",
      description: "Runs in the task's own worktree before work counts as ready.",
      properties: {
        testCommand: { type: "string", title: "Test command (e.g. pnpm test)" },
        lintCommand: { type: "string", title: "Lint command (e.g. pnpm lint)" },
        maxDiffLines: {
          type: "integer",
          title: "Max changed lines per task",
          minimum: 1,
          default: DEFAULT_MAX_DIFF_LINES,
        },
        timeoutSeconds: {
          type: "integer",
          title: "Time limit per check (seconds)",
          minimum: 10,
          maximum: 3600,
          default: DEFAULT_CHECK_TIMEOUT_SECONDS,
        },
      },
    },
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
            maximum: MAX_TASKS_PER_NIGHT,
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
    if (
      !Number.isInteger(maxTasksPerNight) ||
      (maxTasksPerNight as number) < 1 ||
      (maxTasksPerNight as number) > MAX_TASKS_PER_NIGHT
    ) {
      errors.push(`${at}.maxTasksPerNight: must be a whole number 1-${MAX_TASKS_PER_NIGHT}`);
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

  const checks = parseChecks(raw.checks, errors);
  const night = parseNight(raw.night, errors);
  const links = parseLinks(raw.links, errors);

  return errors.length > 0 ? { ok: false, errors } : { ok: true, settings: { people, checks, night, links } };
}

function parseLinks(raw: unknown, errors: string[]): LinkSettings | null {
  if (raw === undefined || raw === null) return null;
  if (!isRecord(raw)) {
    errors.push("links: must be an object");
    return null;
  }
  if (raw.baseUrl === undefined && raw.signingSecret === undefined) return null;
  let baseUrl = "";
  try {
    const url = new URL(String(raw.baseUrl ?? ""));
    if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("protocol");
    baseUrl = url.toString().replace(/\/+$/, "");
  } catch {
    errors.push("links.baseUrl: must be an http(s) address");
  }
  const signingSecret = parseSecretRef(raw.signingSecret);
  if (!signingSecret) errors.push("links.signingSecret: must be a Paperclip secret reference");
  let expiresMinutes = DEFAULT_LINK_EXPIRES_MINUTES;
  if (raw.expiresMinutes !== undefined) {
    const v = raw.expiresMinutes;
    if (!Number.isInteger(v) || (v as number) < 1 || (v as number) > 4320) errors.push("links.expiresMinutes: must be a whole number 1-4320");
    else expiresMinutes = v as number;
  }
  return baseUrl && signingSecret ? { baseUrl, signingSecret, expiresMinutes } : null;
}

function intInRange(raw: Record<string, unknown>, key: string, min: number, max: number, errors: string[], fallback: number): number {
  const value = raw[key];
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || (value as number) < min || (value as number) > max) {
    errors.push(`night.${key}: must be a whole number ${min}-${max}`);
    return fallback;
  }
  return value as number;
}

function parseNight(raw: unknown, errors: string[]): NightSettings {
  if (raw === undefined) return { ...DEFAULT_NIGHT };
  if (!isRecord(raw)) {
    errors.push("night: must be an object");
    return { ...DEFAULT_NIGHT };
  }
  let projectId: string | null = null;
  if (raw.projectId !== undefined && raw.projectId !== null && raw.projectId !== "") {
    if (typeof raw.projectId !== "string") errors.push("night.projectId: must be text");
    else projectId = raw.projectId.trim();
  }
  return {
    projectId,
    proposalLeadHours: intInRange(raw, "proposalLeadHours", 1, 12, errors, DEFAULT_NIGHT.proposalLeadHours),
    nightLengthHours: intInRange(raw, "nightLengthHours", 1, 16, errors, DEFAULT_NIGHT.nightLengthHours),
    stepTimeoutMinutes: intInRange(raw, "stepTimeoutMinutes", 5, 480, errors, DEFAULT_NIGHT.stepTimeoutMinutes),
    maxRetries: intInRange(raw, "maxRetries", 0, 3, errors, DEFAULT_NIGHT.maxRetries),
  };
}

function parseChecks(raw: unknown, errors: string[]): ChecksSettings {
  const checks: ChecksSettings = {
    testCommand: null,
    lintCommand: null,
    maxDiffLines: DEFAULT_MAX_DIFF_LINES,
    timeoutSeconds: DEFAULT_CHECK_TIMEOUT_SECONDS,
  };
  if (raw === undefined) return checks;
  if (!isRecord(raw)) {
    errors.push("checks: must be an object");
    return checks;
  }
  for (const key of ["testCommand", "lintCommand"] as const) {
    const value = raw[key];
    if (value === undefined || value === null || value === "") continue;
    if (typeof value !== "string") errors.push(`checks.${key}: must be text`);
    else checks[key] = value.trim();
  }
  if (raw.maxDiffLines !== undefined) {
    if (!Number.isInteger(raw.maxDiffLines) || (raw.maxDiffLines as number) < 1) {
      errors.push("checks.maxDiffLines: must be a whole number, 1 or more");
    } else checks.maxDiffLines = raw.maxDiffLines as number;
  }
  if (raw.timeoutSeconds !== undefined) {
    const t = raw.timeoutSeconds;
    if (!Number.isInteger(t) || (t as number) < 10 || (t as number) > 3600) {
      errors.push("checks.timeoutSeconds: must be a whole number 10-3600");
    } else checks.timeoutSeconds = t as number;
  }
  return checks;
}

export function findPersonByEmail(settings: PluginSettings, email: string): Person | undefined {
  const wanted = email.trim().toLowerCase();
  return settings.people.find((p) => p.email === wanted);
}

export function findPersonByAgent(settings: PluginSettings, agentId: string): Person | undefined {
  return settings.people.find((p) => p.agentId === agentId);
}
