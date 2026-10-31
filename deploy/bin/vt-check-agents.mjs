// Part of vt-check: is every person's agent isolated? (thin version 1, piece A)
// Asks Paperclip (board API key) about each person's agent and environment, and
// prints "OK ..." / "PROBLEM ..." / "WARNING ..." lines, plus "USER <name>" for
// each agent's system user so vt-check can test that user's file access itself.
// Usage: node vt-check-agents.mjs <paperclipUrl> <apiKeyFile> <companyId>
import { readFileSync } from "node:fs";

const [base, keyFile, cid] = process.argv.slice(2);
const key = readFileSync(keyFile, "utf8").trim();
const PLUGIN_KEY = "vision-and-tom.night-agents";
async function call(method, path, body) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  return { status: res.status, data: await res.json().catch(() => null) };
}
const out = (kind, text) => process.stdout.write(`${kind} ${text}\n`);

const plugin = ((await call("GET", "/api/plugins")).data ?? []).find((p) => (p.pluginKey ?? p.key) === PLUGIN_KEY);
if (!plugin) {
  out("PROBLEM", "the Aurora plugin is not installed (run: vt-setup)");
  process.exit(0);
}
const config = (await call("GET", `/api/plugins/${plugin.id}/config?companyId=${cid}`)).data?.configJson ?? {};
if (config.isolation?.required === false) out("PROBLEM", "agent isolation is turned off in the plugin settings (isolation.required)");
else out("OK", "agent isolation is required in the plugin settings");

const users = new Set();
for (const p of config.people ?? []) {
  const who = p.email;
  if (!p.agentEnvironmentId || !p.agentUser) {
    out("PROBLEM", `${who}: the agent has no system user of its own (run vt-setup again for the owner, or invite again)`);
    continue;
  }
  if (users.has(p.agentUser)) out("PROBLEM", `${who}: shares the system user ${p.agentUser} with someone else`);
  users.add(p.agentUser);
  const env = (await call("GET", `/api/environments/${p.agentEnvironmentId}`)).data;
  const agent = (await call("GET", `/api/agents/${p.agentId}`)).data;
  const envOk = env?.driver === "ssh" && env?.config?.username === p.agentUser && env?.config?.host === "127.0.0.1";
  if (!envOk) out("PROBLEM", `${who}: Paperclip's environment for the agent is not SSH to ${p.agentUser} on 127.0.0.1`);
  else if (agent?.defaultEnvironmentId !== p.agentEnvironmentId) out("PROBLEM", `${who}: the agent does not run in its own environment`);
  else {
    const probe = (await call("POST", `/api/environments/${p.agentEnvironmentId}/probe`, {})).data;
    if (probe?.ok) out("OK", `${who}: the agent runs as its own system user ${p.agentUser} (SSH login works)`);
    else out("PROBLEM", `${who}: Paperclip cannot log in as ${p.agentUser} (${String(probe?.summary ?? probe?.error ?? "no answer").slice(0, 120)})`);
  }
  out("USER", p.agentUser);
}
const audit = (await call("POST", `/api/plugins/${plugin.id}/data/route-audit`, { companyId: cid, params: {} })).data?.data;
if (audit?.ok) out("OK", "the plugin's route and isolation audit passes for every agent");
else {
  const why = [...(audit?.settingsProblems ?? []), ...(audit?.agents ?? []).flatMap((a) => a.problems.map((x) => `${a.email}: ${x}`))];
  out("PROBLEM", `the plugin's audit refuses: ${why.join("; ").slice(0, 300) || "no answer"}`);
}

// GitHub teams in CODEOWNERS match nobody (Aurora cannot see who is in a team): name them so the admin can list people.
const owners = (await call("POST", `/api/plugins/${plugin.id}/data/codeowners`, { companyId: cid, params: {} })).data?.data;
if (owners?.ok && owners.teams?.length) {
  for (const t of owners.teams) {
    out("WARNING", `${owners.source} names the GitHub team ${t.team} (line${t.lines.length > 1 ? "s" : ""} ${t.lines.join(", ")}); Aurora cannot see who is in a team, so nobody is protected there. List the people instead (GitHub login or email).`);
  }
} else if (owners?.ok && owners.source && owners.source !== "none") out("OK", `${owners.source} names people only (no GitHub teams)`);
else if (owners?.ok) out("OK", "no CODEOWNERS file: owner areas are not used (only claims are compared)");
