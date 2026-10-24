// Rehearsal stand-in for systemd (this machine has none): starts and stops a
// service exactly as its installed unit file says (ExecStart, WorkingDirectory,
// Environment, EnvironmentFile, LoadCredential with %d), so the unit files are
// what gets tested. Differences from systemd: everything runs as the current
// user (root here), and sandboxing options are not applied.
//   node unit.mjs start|stop <unit file> <state dir>
import { spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

const [cmd, unitFile, stateDir] = process.argv.slice(2);
const name = path.basename(unitFile);
const pidFile = path.join(stateDir, `${name}.pid`);
mkdirSync(stateDir, { recursive: true });

function parseUnit(text) {
  const service = [];
  let section = "";
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const s = /^\[(.+)\]$/.exec(line);
    if (s) section = s[1];
    else if (section === "Service") {
      const i = line.indexOf("=");
      service.push([line.slice(0, i), line.slice(i + 1)]);
    }
  }
  return service;
}

function envFile(file) {
  const env = {};
  for (const raw of readFileSync(file, "utf8").split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || !line.includes("=")) continue;
    const i = line.indexOf("=");
    let v = line.slice(i + 1);
    if (/^".*"$/.test(v)) v = v.slice(1, -1);
    env[line.slice(0, i)] = v;
  }
  return env;
}

if (cmd === "stop") {
  if (existsSync(pidFile)) {
    const pid = Number(readFileSync(pidFile, "utf8"));
    try {
      process.kill(-pid, "SIGTERM");
    } catch {}
    for (let i = 0; i < 60; i++) {
      try {
        process.kill(pid, 0);
      } catch {
        break;
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    try {
      process.kill(-pid, "SIGKILL");
    } catch {}
    rmSync(pidFile, { force: true });
  }
  process.exit(0);
}

const service = parseUnit(readFileSync(unitFile, "utf8"));
const credDir = path.join(stateDir, "credentials", name);
rmSync(credDir, { recursive: true, force: true });
mkdirSync(credDir, { recursive: true, mode: 0o700 });
const env = { PATH: process.env.PATH, LANG: "C.UTF-8" };
let cwd = "/";
let exec = null;
for (const [k, v] of service) {
  if (k === "WorkingDirectory") cwd = v;
  else if (k === "EnvironmentFile") Object.assign(env, envFile(v.replace(/^-/, "")));
  else if (k === "Environment") {
    const i = v.indexOf("=");
    env[v.slice(0, i)] = v.slice(i + 1).replaceAll("%d", credDir);
  } else if (k === "LoadCredential") {
    const [id, src] = v.split(":");
    // Like systemd: a missing source file means the service does not start.
    copyFileSync(src, path.join(credDir, id));
  } else if (k === "ExecStart") exec = v.replaceAll("%d", credDir);
}
if (!exec) throw new Error(`${name}: no ExecStart`);
const [bin, ...args] = exec.split(/\s+/);
const log = openSync(path.join(stateDir, `${name}.log`), "a");
const child = spawn(bin, args, { cwd, env, detached: true, stdio: ["ignore", log, log] });
writeFileSync(pidFile, String(child.pid));
child.unref();
