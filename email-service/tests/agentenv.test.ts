import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ensureAgentEnvironment, isolatedAdapterConfig, parseAgentLogin, type Call } from "../src/agentenv.ts";

function keys() {
  const dir = mkdtempSync(path.join(tmpdir(), "vt-agentenv-"));
  writeFileSync(path.join(dir, "run"), "RUN-PRIVATE");
  writeFileSync(path.join(dir, "checks"), "CHECKS-PRIVATE");
  return { runKeyFile: path.join(dir, "run"), checksKeyFile: path.join(dir, "checks") };
}
const login = () => ({ user: "vt-a-0123456789", host: "127.0.0.1", port: 22, knownHosts: "127.0.0.1 ssh-ed25519 AAAA", ...keys() });

/** A fake board API that keeps environments and secrets in memory. */
function fakeBoard() {
  const envs: Array<{ id: string; name: string; config: Record<string, unknown> }> = [];
  const secrets: Array<{ id: string; key: string; value: string }> = [];
  const log: string[] = [];
  const call: Call = async <T,>(method: string, p: string, body?: unknown) => {
    const b = body as Record<string, any>;
    log.push(`${method} ${p.replace(/[0-9a-z]{8}-[0-9a-z-]+|e\d+|s\d+/g, ":id")}`);
    if (method === "GET" && p.endsWith("/environments")) return envs as T;
    if (method === "POST" && p.endsWith("/environments")) {
      envs.push({ id: `e${envs.length + 1}`, name: b.name, config: b.config });
      return envs.at(-1) as T;
    }
    if (method === "PATCH") {
      const e = envs.find((x) => p.endsWith(x.id))!;
      e.config = b.config;
      return e as T;
    }
    if (method === "GET" && p.endsWith("/secrets")) return secrets.map(({ id, key }) => ({ id, key })) as T;
    if (method === "POST" && p.endsWith("/secrets")) {
      secrets.push({ id: `s${secrets.length + 1}`, key: b.key, value: b.value });
      return secrets.at(-1) as T;
    }
    if (method === "POST" && p.endsWith("/rotate")) {
      secrets.find((x) => p.includes(x.id))!.value = b.value;
      return {} as T;
    }
    throw new Error(`unexpected ${method} ${p}`);
  };
  return { call, envs, secrets, log };
}

describe("ensureAgentEnvironment", () => {
  it("creates the agent's SSH environment and its checks key, then replaces the keys on a second run", async () => {
    const pc = fakeBoard();
    const first = await ensureAgentEnvironment(pc.call, "co", login());
    expect(first).toEqual({ agentEnvironmentId: "e1", agentUser: "vt-a-0123456789", checksKey: { type: "secret_ref", secretId: "s1" } });
    expect(pc.envs[0]).toMatchObject({
      name: "Agent user vt-a-0123456789",
      config: { host: "127.0.0.1", port: 22, username: "vt-a-0123456789", remoteWorkspacePath: "/home/vt-a-0123456789/work", privateKey: "RUN-PRIVATE", strictHostKeyChecking: true },
    });
    expect(pc.secrets[0]).toMatchObject({ key: "vt-checks-key-vt-a-0123456789", value: "CHECKS-PRIVATE" });

    // Again for the same person (a new invite, or vt-setup run twice): same environment and secret, new keys.
    const again = login();
    writeFileSync(again.runKeyFile, "RUN-2");
    writeFileSync(again.checksKeyFile, "CHECKS-2");
    expect(await ensureAgentEnvironment(pc.call, "co", again)).toEqual(first);
    expect(pc.envs).toHaveLength(1);
    expect(pc.envs[0]!.config.privateKey).toBe("RUN-2");
    expect(pc.secrets).toHaveLength(1);
    expect(pc.secrets[0]!.value).toBe("CHECKS-2");
  });
});

describe("parseAgentLogin", () => {
  it("accepts what agents.sh writes and refuses anything else", () => {
    const l = login();
    expect(parseAgentLogin(JSON.stringify(l))).toEqual(l);
    expect(parseAgentLogin(undefined)).toBeNull();
    expect(() => parseAgentLogin(JSON.stringify({ ...l, user: "-oProxyCommand=x" }))).toThrow("bad user name");
    expect(() => parseAgentLogin(JSON.stringify({ ...l, knownHosts: "" }))).toThrow("no host key");
  });
});

describe("isolatedAdapterConfig", () => {
  it("adds Claude's CLI engine (Paperclip runs Claude over SSH only with it) and leaves other adapters alone", () => {
    expect(isolatedAdapterConfig("claude_local", { model: "m" })).toEqual({ model: "m", engine: "cli" });
    expect(isolatedAdapterConfig("codex_local", { a: 1 })).toEqual({ a: 1 });
  });
});
