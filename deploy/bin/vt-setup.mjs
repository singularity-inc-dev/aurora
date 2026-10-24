// First-time setup through Paperclip's own API, on the server itself
// (127.0.0.1, never through the public address). Called by vt-setup.
// Input (stdin, JSON): owner {name,email,password}, companyName, bootstrapToken,
// publicUrl, paperclipUrl, pluginPath, githubRepo, projectRepoPath, apiKeyFile,
// invites (optional overrides). Output (stdout, JSON): { companyId }.
// Safe to run again: it finds what already exists instead of making it twice.
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

const input = JSON.parse(readFileSync(0, "utf8"));
const base = input.paperclipUrl;
const origin = new URL(input.publicUrl).origin;
const PLUGIN_KEY = "vision-and-tom.night-agents";
const log = (m) => process.stderr.write(`  - ${m}\n`);

async function call(method, path, body, { cookie, key, ok = [] } = {}) {
  const headers = { "content-type": "application/json", origin };
  if (cookie) headers.cookie = cookie;
  if (key) headers.authorization = `Bearer ${key}`;
  const res = await fetch(`${base}${path}`, { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  if (!res.ok && !ok.includes(res.status)) {
    throw new Error(`Paperclip answered ${res.status} to ${method} ${path.replace(/[0-9a-f-]{36}/g, ":id").split("?")[0]}: ${String(data?.error ?? data?.message ?? "").slice(0, 200)}`);
  }
  return { status: res.status, data, res };
}
const cookieOf = (res) => res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");

// 1. The owner's account (sign-up only works here, on the server: the public address refuses it).
let session;
const signUp = await call("POST", "/api/auth/sign-up/email", { email: input.owner.email, password: input.owner.password, name: input.owner.name }, { ok: [400, 422] });
if (signUp.status === 200) {
  session = cookieOf(signUp.res);
  log(`account created for ${input.owner.email}`);
} else {
  const signIn = await call("POST", "/api/auth/sign-in/email", { email: input.owner.email, password: input.owner.password });
  session = cookieOf(signIn.res);
  log(`signed in as ${input.owner.email} (account already existed)`);
}

// 2. Make the owner the instance admin (Paperclip's one-time bootstrap invite).
if (input.bootstrapToken) {
  const r = await call("POST", `/api/invites/${input.bootstrapToken}/accept`, { requestType: "human" }, { cookie: session, ok: [404, 409] });
  log(r.status === 202 ? "you are now the instance admin" : "instance admin already set up");
}

// 3. The company.
const companies = (await call("GET", "/api/companies", undefined, { cookie: session })).data;
let company = (Array.isArray(companies) ? companies : companies?.items ?? []).find((c) => c.name === input.companyName);
if (!company) {
  company = (await call("POST", "/api/companies", { name: input.companyName }, { cookie: session })).data;
  log(`company "${input.companyName}" created`);
}
const cid = company.id;

// 4. A board API key for the email service (stored as a root-only secret file).
let apiKey = existsSync(input.apiKeyFile) ? readFileSync(input.apiKeyFile, "utf8").trim() : "";
if (apiKey && (await call("GET", `/api/companies/${cid}`, undefined, { key: apiKey, ok: [401, 403] })).status !== 200) apiKey = "";
if (!apiKey) {
  const created = (await call("POST", "/api/board-api-keys", { name: "vision-and-tom email service", requestedCompanyId: cid }, { cookie: session })).data;
  apiKey = created.token ?? created.key ?? created.apiKey;
  if (!apiKey) throw new Error("Paperclip did not return the new API key");
  writeFileSync(input.apiKeyFile, apiKey, { mode: 0o600 });
  log("API key for the email service saved");
}
const board = { key: apiKey };

// 5. The plugin.
const plugins = (await call("GET", "/api/plugins", undefined, board)).data ?? [];
let plugin = plugins.find((p) => (p.pluginKey ?? p.key) === PLUGIN_KEY);
if (!plugin) {
  plugin = (await call("POST", "/api/plugins/install", { packageName: input.pluginPath, isLocalPath: true }, board)).data;
  log("plugin installed");
}
const pluginId = plugin.id ?? plugin.plugin?.id;
for (let i = 0; i < 60; i++) {
  const p = ((await call("GET", "/api/plugins", undefined, board)).data ?? []).find((x) => x.id === pluginId);
  if (p?.status === "ready") break;
  await new Promise((r) => setTimeout(r, 1000));
}

// 6. Per-task worktrees (Paperclip's experimental setting; decided in M2).
await call("PATCH", "/api/instance/settings/experimental", { enableIsolatedWorkspaces: true }, board);

// 7. Plugin settings: links, GitHub, the project, invites, and the owner as the first person.
const current = (await call("GET", `/api/plugins/${pluginId}/config?companyId=${cid}`, undefined, board)).data?.configJson ?? {};
let signingSecret = current.links?.signingSecret;
if (!signingSecret) {
  const s = (await call("POST", `/api/companies/${cid}/secrets`, { name: "vt-link-signing", key: `vt-link-signing-${randomBytes(3).toString("hex")}`, value: randomBytes(32).toString("hex") }, board)).data;
  signingSecret = { type: "secret_ref", secretId: s.id };
  log("link signing key created (kept inside Paperclip)");
}
const invites = { ...(current.invites ?? {}), ...(input.invites ?? {}) };
let projectId = current.night?.projectId;
if (!projectId && input.projectRepoPath) {
  const p = (await call("POST", `/api/companies/${cid}/projects`, {
    name: input.githubRepo ? input.githubRepo.split("/")[1] : "project",
    executionWorkspacePolicy: { enabled: true, defaultMode: "isolated_workspace", allowIssueOverride: true, workspaceStrategy: { type: "git_worktree" } },
    workspace: { name: "repository", sourceType: "local_path", cwd: input.projectRepoPath, isPrimary: true },
  }, board)).data;
  projectId = p.id;
  log("project created for the repository");
}
const people = Array.isArray(current.people) ? current.people : [];
if (!people.some((p) => String(p.email).toLowerCase() === input.owner.email.toLowerCase())) {
  const agent = (await call("POST", `/api/companies/${cid}/agents`, {
    name: `${input.owner.name}'s night agent`,
    role: "engineer",
    adapterType: invites.agentAdapterType ?? "claude_local",
    adapterConfig: invites.agentAdapterConfig ?? {},
    budgetMonthlyCents: invites.agentMonthlyBudgetCents ?? 3000,
    permissions: { canCreateAgents: false, canCreateSkills: false },
  }, board)).data;
  await call("PATCH", `/api/agents/${agent.id}/permissions`, { canCreateAgents: false, canCreateSkills: false, canAssignTasks: true }, board);
  people.push({
    email: input.owner.email.toLowerCase(),
    agentId: agent.id,
    timezone: input.ownerTimezone || invites.defaultTimezone || "UTC",
    nightStartHour: invites.nightStartHour ?? 22,
    maxTasksPerNight: invites.maxTasksPerNight ?? 3,
    nightBudgetCapCents: invites.nightBudgetCapCents ?? 300,
    secrets: [],
  });
  log("your night agent created (cannot create agents or skills)");
}
const config = {
  ...current,
  links: { ...(current.links ?? {}), baseUrl: `${input.publicUrl}/vt`, signingSecret },
  ...(input.githubRepo ? { github: { repo: input.githubRepo } } : {}),
  night: { ...(current.night ?? {}), ...(projectId ? { projectId } : {}) },
  invites,
  people,
};
await call("POST", `/api/plugins/${pluginId}/config`, { companyId: cid, configJson: config }, board);
const test = (await call("POST", `/api/plugins/${pluginId}/config/test`, { companyId: cid, configJson: config }, board)).data;
if (test && test.valid === false) throw new Error(`plugin settings are not valid: ${test.message}`);
log("plugin settings saved and checked");
process.stdout.write(JSON.stringify({ companyId: cid }));
