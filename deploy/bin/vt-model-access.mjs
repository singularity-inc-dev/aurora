// Part of vt-model-access: how one person's agent uses Claude (thin version 1, piece B).
// Each owner chooses: their own Claude subscription (signed in later with Claude
// Code's own login on their agent's user), or their own API key, which they stored
// themselves as a Paperclip secret. Never one shared account. This reads no key
// value and no login: it only points the agent at the owner's own secret.
//
// Usage: node vt-model-access.mjs <paperclipUrl> <apiKeyFile|-> <companyId> <email> subscription
//        node vt-model-access.mjs <paperclipUrl> <apiKeyFile|-> <companyId> <email> api-key <secret key>
// Prints one JSON line: {"ok":true,"agentUser":...,"modelAccess":...} or {"ok":false,"message":...}.
import { readFileSync } from "node:fs";

const [base, keyFile, cid, rawEmail, mode, secretKey] = process.argv.slice(2);
const PLUGIN_KEY = "vision-and-tom.night-agents";
const MODEL_KEY_NAME = "anthropic-api-key";
const AUTH_ENV = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN"];
const key = keyFile && keyFile !== "-" ? readFileSync(keyFile, "utf8").trim() : null;
const done = (out) => {
  process.stdout.write(`${JSON.stringify(out)}\n`);
  process.exit(out.ok ? 0 : 1);
};
async function call(method, path, body) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { "content-type": "application/json", ...(key ? { authorization: `Bearer ${key}` } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) done({ ok: false, message: `Paperclip answered ${res.status} for ${method} ${path.replace(/[0-9a-f-]{36}/g, ":id").split("?")[0]}` });
  return data;
}

if (mode !== "subscription" && mode !== "api-key") done({ ok: false, message: "the choice must be subscription or api-key" });
if (mode === "api-key" && !secretKey) done({ ok: false, message: "name the secret that holds the owner's own API key" });
const email = String(rawEmail ?? "").trim().toLowerCase();
const plugin = ((await call("GET", "/api/plugins")) ?? []).find((p) => (p.pluginKey ?? p.key) === PLUGIN_KEY);
if (!plugin) done({ ok: false, message: "the plugin is not installed" });
const config = (await call("GET", `/api/plugins/${plugin.id}/config?companyId=${cid}`))?.configJson ?? {};
const people = Array.isArray(config.people) ? config.people : [];
const person = people.find((p) => String(p.email).toLowerCase() === email);
if (!person) done({ ok: false, message: `${email} is not on the team` });

const agent = await call("GET", `/api/agents/${person.agentId}`);
const env = { ...(agent.adapterConfig?.env ?? {}) };
for (const k of AUTH_ENV) delete env[k];
let secrets = (Array.isArray(person.secrets) ? person.secrets : []).filter((s) => s.name !== MODEL_KEY_NAME);
if (mode === "api-key") {
  const list = await call("GET", `/api/companies/${cid}/secrets`);
  const secret = (Array.isArray(list) ? list : list?.items ?? []).find((s) => s.key === secretKey);
  if (!secret) done({ ok: false, message: `no secret with the key "${secretKey}"; the owner stores their own API key in Paperclip first` });
  const holder = people.find((p) => p !== person && (p.secrets ?? []).some((s) => s.secret?.secretId === secret.id));
  if (holder) done({ ok: false, message: `that secret is already ${holder.email}'s key (never one shared account)` });
  const ref = { type: "secret_ref", secretId: secret.id };
  env.ANTHROPIC_API_KEY = ref;
  secrets = [...secrets, { name: MODEL_KEY_NAME, secret: ref, access: "read-only" }];
}
await call("PATCH", `/api/agents/${person.agentId}`, { adapterConfig: { ...(agent.adapterConfig ?? {}), env } });
Object.assign(person, { modelAccess: mode, secrets });
await call("POST", `/api/plugins/${plugin.id}/config`, { companyId: cid, configJson: config });
const test = await call("POST", `/api/plugins/${plugin.id}/config/test`, { companyId: cid, configJson: config });
if (test && test.valid === false) done({ ok: false, message: `the plugin settings are not valid now: ${test.message}` });
done({ ok: true, agentUser: person.agentUser ?? null, modelAccess: mode });
