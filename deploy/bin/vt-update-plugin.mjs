// Part of vt-update: talks to Paperclip with the board API key.
//   node vt-update-plugin.mjs <paperclipUrl> <apiKeyFile> <companyId> running
//     prints one line per person whose handover is running (agents are working)
//   node vt-update-plugin.mjs <paperclipUrl> <apiKeyFile> <companyId> version
//     prints the installed plugin's version, or "none"
//   node vt-update-plugin.mjs <paperclipUrl> <apiKeyFile> <companyId> disable
//     stops the plugin before its files change (Paperclip watches a plugin's folder
//     and would restart it half-built, then refuse to install the new version)
//   node vt-update-plugin.mjs <paperclipUrl> <apiKeyFile> <companyId> reload <pluginFolder> <version>
//     a new version is installed again (uninstalling without "purge" keeps its settings
//     and data; Paperclip refuses an upgrade that adds permissions); the same version
//     is restarted so it runs the code just built. Exits non-zero unless it ends "ready".
import { readFileSync } from "node:fs";

const [base, keyFile, cid, cmd, folder, want] = process.argv.slice(2);
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
const find = async () => ((await call("GET", "/api/plugins")).data ?? []).find((p) => (p.pluginKey ?? p.key) === PLUGIN_KEY);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(test) {
  for (let i = 0; i < 90; i += 1) {
    const p = await find();
    if (test(p)) return p;
    await sleep(1000);
  }
  return find();
}
async function waitReady() {
  for (let i = 0; i < 90; i += 1) {
    const p = await find();
    if (p?.status === "ready") return p;
    await sleep(1000);
  }
  return find();
}
const fail = (msg) => {
  process.stderr.write(`${msg}\n`);
  process.exit(1);
};

if (cmd === "running") {
  const plugin = await find();
  if (!plugin) process.exit(0);
  const runs = (await call("POST", `/api/plugins/${plugin.id}/data/handover-status`, { companyId: cid, params: {} })).data?.data ?? [];
  for (const r of runs) if (r.status === "running" || r.status === "approved") process.stdout.write(`${r.owner} (${r.kind === "now" ? "Hand over now" : "scheduled"}, ${r.status})\n`);
} else if (cmd === "version") {
  process.stdout.write(`${(await find())?.version ?? "none"}\n`);
} else if (cmd === "disable") {
  const plugin = await find();
  if (plugin && plugin.status !== "disabled") {
    await call("POST", `/api/plugins/${plugin.id}/disable`, {});
    const p = await waitFor((x) => !x || x.status === "disabled");
    if (p && p.status !== "disabled") fail(`Paperclip did not stop the plugin (it is ${p.status})`);
  }
  process.stdout.write("plugin stopped for the update\n");
} else if (cmd === "reload") {
  let plugin = await find();
  if (plugin && plugin.version !== want) {
    const del = await call("DELETE", `/api/plugins/${plugin.id}`);
    if (del.status !== 200) fail(`Paperclip did not uninstall the old plugin (${del.status})`);
    if (await waitFor((x) => !x)) fail("Paperclip still lists the old plugin after uninstalling it");
    plugin = null;
  }
  if (!plugin) {
    const res = await call("POST", "/api/plugins/install", { packageName: folder, isLocalPath: true });
    if (res.status >= 300) fail(`Paperclip did not install the plugin (${res.status}: ${String(res.data?.error ?? "").slice(0, 200)})`);
  } else {
    // Same version, new build: starting it again makes its worker load the new code.
    if (plugin.status !== "disabled") {
      await call("POST", `/api/plugins/${plugin.id}/disable`, {});
      await waitFor((x) => !x || x.status === "disabled");
    }
    await call("POST", `/api/plugins/${plugin.id}/enable`, {});
  }
  const ready = await waitReady();
  if (ready?.status !== "ready" || ready.version !== want) fail(`the plugin is ${ready?.status ?? "missing"} at version ${ready?.version ?? "none"}, not ready at ${want}`);
  const people = (await call("GET", `/api/plugins/${ready.id}/config?companyId=${cid}`)).data?.configJson?.people ?? [];
  process.stdout.write(`plugin ${want} is ready; its settings list ${people.length} people\n`);
} else fail("usage: vt-update-plugin.mjs <url> <keyFile> <companyId> running|version|disable|reload <folder> <version>");
