import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.ts";
import { sendPending } from "../src/mailer.ts";
import { esc } from "../src/pages.ts";
import type { Email, LinkCheck, LinkOutcome, PluginApi } from "../src/paperclip.ts";
import { createLinkServer } from "../src/server.ts";

const TOKEN = "eyJ2IjoxLCJhIjoiYWN0In0." + "s".repeat(43);

function fakeApi(over: Partial<PluginApi> = {}): PluginApi & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async pendingEmails() {
      return [];
    },
    async markSent(id) {
      calls.push(`sent:${id}`);
    },
    async preview(token): Promise<LinkCheck> {
      calls.push(`preview:${token === TOKEN}`);
      return { ok: true, status: "valid", message: "ok", kind: "approve", task: { identifier: "VT-1", title: "Fix <login>" } };
    },
    async execute(_token, reason): Promise<LinkOutcome> {
      calls.push(`execute:${reason}`);
      return { ok: true, status: "merged", message: "VT-1 was merged into main." };
    },
    async publishResult(_token, result): Promise<LinkOutcome> {
      calls.push(`publish-result:${result.result}`);
      return result.result === "waiting"
        ? { ok: true, status: "waiting", message: `pull request #${result.number} is waiting for review` }
        : result.result === "merged"
          ? { ok: true, status: "merged", message: `merged as #${result.number}` }
          : { ok: false, status: "refused", message: `Not merged: ${result.message}.` };
    },
    async waitingPullRequests() {
      return { repo: null, pullRequests: [] };
    },
    async pullRequestUpdate(taskId, state) {
      calls.push(`pr-update:${taskId}:${state}`);
    },
    async createInvite() {
      return { ok: false, message: "not in this test" };
    },
    async previewInvite() {
      return { ok: true, status: "valid", message: "ok", email: "cy@example.com", timezone: "Europe/Berlin" };
    },
    async claimInvite() {
      calls.push("claim");
      return { ok: true, status: "claimed", plan: { inviteId: "inv-1", email: "cy@example.com", timezone: "Europe/Berlin", defaults: { nightStartHour: 22, nightBudgetCapCents: 300, maxTasksPerNight: 3, agentAdapterType: "process", agentAdapterConfig: {}, agentMonthlyBudgetCents: 3000 } } };
    },
    async finishInvite(_id, result) {
      calls.push(`finish:${result.ok}`);
      return { ok: true, message: "joined" };
    },
    ...over,
  };
}

let server: ReturnType<typeof createLinkServer> | null = null;
afterEach(() => server?.close());
async function start(api: PluginApi): Promise<string> {
  server = createLinkServer(api);
  await new Promise<void>((r) => server!.listen(0, "127.0.0.1", r));
  return `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
}

describe("link pages", () => {
  it("opening a link only shows a confirmation page; nothing is executed", async () => {
    const api = fakeApi();
    const base = await start(api);
    const res = await fetch(`${base}/l/${TOKEN}`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Approve and merge");
    expect(html).toContain("Fix &lt;login&gt;");
    expect(api.calls).toEqual(["preview:true"]);
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("the button (POST) executes once per press and shows the result", async () => {
    const api = fakeApi();
    const base = await start(api);
    const res = await fetch(`${base}/l/${TOKEN}`, { method: "POST", body: "", headers: { "content-type": "application/x-www-form-urlencoded" } });
    expect(await res.text()).toContain("VT-1 was merged into main.");
    expect(api.calls).toEqual(["execute:null"]);
  });

  it("passes the reject reason from the form", async () => {
    const api = fakeApi();
    const base = await start(api);
    await fetch(`${base}/l/${TOKEN}`, { method: "POST", body: "reason=Wrong+approach", headers: { "content-type": "application/x-www-form-urlencoded" } });
    expect(api.calls).toEqual(["execute:Wrong approach"]);
  });

  it("asks again for a reason when the plugin needs one", async () => {
    const api = fakeApi({
      async execute() {
        return { ok: false, status: "needs-reason", message: "Please give a one-line reason." };
      },
      async preview() {
        return { ok: true, status: "valid", message: "ok", kind: "reject", task: { identifier: "VT-1", title: "x" } };
      },
    });
    const base = await start(api);
    const html = await (await fetch(`${base}/l/${TOKEN}`, { method: "POST", body: "" })).text();
    expect(html).toContain("Please give a one-line reason.");
    expect(html).toContain('name="reason"');
  });

  it("rejects malformed tokens without calling Paperclip", async () => {
    const api = fakeApi();
    const base = await start(api);
    expect((await fetch(`${base}/l/not-a-token`)).status).toBe(400);
    expect((await fetch(`${base}/l/${TOKEN}<script>`)).status).toBe(400);
    expect(api.calls).toEqual([]);
  });

  it("refuses oversized form bodies", async () => {
    const base = await start(fakeApi());
    expect((await fetch(`${base}/l/${TOKEN}`, { method: "POST", body: "reason=" + "x".repeat(5000) })).status).toBe(413);
  });

  it("shows a friendly page when Paperclip is down", async () => {
    const base = await start(fakeApi({ preview: () => Promise.reject(new Error("down")) }));
    const res = await fetch(`${base}/l/${TOKEN}`);
    expect(res.status).toBe(502);
  });
});

describe("sending", () => {
  const email: Email = { briefingId: "b1", to: "ana@example.com", subject: "s", text: "t", html: "<p>t</p>" };

  it("marks a briefing sent only after the email went out", async () => {
    const api = fakeApi({ pendingEmails: async () => [email] });
    const sent: string[] = [];
    expect(await sendPending(api, async (e) => void sent.push(e.to))).toBe(1);
    expect(sent).toEqual(["ana@example.com"]);
    expect(api.calls).toEqual(["sent:b1"]);
  });

  it("does not mark it sent when sending fails (it is retried next time)", async () => {
    const api = fakeApi({ pendingEmails: async () => [email] });
    expect(await sendPending(api, () => Promise.reject(new Error("smtp down")))).toBe(0);
    expect(api.calls).toEqual([]);
  });
});

describe("config", () => {
  it("requires the company and has local defaults", () => {
    expect(() => loadConfig({})).toThrow("VT_COMPANY_ID");
    expect(loadConfig({ VT_COMPANY_ID: "co" })).toMatchObject({ paperclipUrl: "http://127.0.0.1:3100", listenPort: 3299, smtp: { port: 1025 } });
  });

  it("escapes HTML", () => {
    expect(esc(`<a href="x">'</a>`)).toBe("&lt;a href=&quot;x&quot;&gt;&#39;&lt;/a&gt;");
  });
});
