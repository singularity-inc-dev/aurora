import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { countRows, countsText, DEFINITIONS, FLAG_COLUMNS, MAIN_COLUMNS, parseRawCounts, type Counts } from "../src/counts.ts";
import { runNumbers, type CliIo } from "../src/numberscli.ts";
import { PaperclipError, paperclipApi, type HandoverStatus, type PluginApi } from "../src/paperclip.ts";
import { createLinkServer } from "../src/server.ts";

const counts = (over: Partial<Counts> = {}): Counts => ({
  handedOver: 0, ready: 0, approved: 0, rejected: 0, failed: 0, notTested: 0, teammateOverlaps: 0, wouldBeConflicts: 0, toolErrors: 0, checksFailed: 0, timedOut: 0, budgetStops: 0, ...over,
});
const RAW = {
  team: counts({ handedOver: 5, ready: 3, approved: 1, rejected: 2, failed: 1, notTested: 1, teammateOverlaps: 2, wouldBeConflicts: 1, toolErrors: 1, checksFailed: 1, timedOut: 1, budgetStops: 1 }),
  people: [
    { owner: "ana@example.com", all: counts({ handedOver: 4, approved: 1 }), kinds: [{ kind: "handoff", counts: counts() }, { kind: "task", counts: counts({ handedOver: 4, approved: 1 }) }] },
    { owner: "bo@example.com", all: counts({ handedOver: 1, rejected: 1 }), kinds: [{ kind: "task", counts: counts({ handedOver: 1, rejected: 1 }) }] },
  ],
};

describe("counts as text", () => {
  const text = countsText(parseRawCounts(RAW));

  it("shows the eight counts per person and per task kind, with the team first", () => {
    const lines = text.split("\n");
    const header = lines.find((l) => l.startsWith("who"))!;
    for (const c of MAIN_COLUMNS) expect(header).toContain(c.label);
    expect(MAIN_COLUMNS.map((c) => c.label)).toEqual(["handed over", "ready", "approved", "rejected", "failed", "not tested", "teammate overlaps", "would-be conflicts"]);
    expect(lines.findIndex((l) => l.startsWith("Team (everyone)"))).toBeLessThan(lines.findIndex((l) => l.startsWith("ana@example.com")));
    expect(text).toContain("  task kind: handoff");
    expect(text).toContain("  task kind: task");
  });

  it("lines the numbers up under their headings", () => {
    const [header, team] = text.split("\n").filter((l) => l.startsWith("who") || l.startsWith("Team (everyone)"));
    const col = header!.indexOf("would-be conflicts") + "would-be conflicts".length;
    expect(team!.slice(0, col).trimEnd().endsWith("1")).toBe(true); // 1 would-be conflict, right-aligned under its heading
  });

  it("never shows a percentage, a rate or an average", () => {
    expect(text.replace("no percentages", "")).not.toMatch(/%|percent|yield|rate\b|average|median/i);
  });

  it("prints what each number means", () => {
    expect(text).toContain("Teammate overlaps: pairs of tasks owned by two different people");
    expect(DEFINITIONS.length).toBeGreaterThanOrEqual(MAIN_COLUMNS.length);
    expect(FLAG_COLUMNS.map((c) => c.label)).toEqual(["tool errors", "checks failed", "timed out", "budget stops"]);
  });

  it("countRows gives the team, each person, then that person's kinds", () => {
    expect(countRows(parseRawCounts(RAW)).map((r) => `${r.level}:${r.label}`)).toEqual([
      "team:Team (everyone)", "person:ana@example.com", "kind:task kind: handoff", "kind:task kind: task", "person:bo@example.com", "kind:task kind: task",
    ]);
  });
});

describe("parseRawCounts", () => {
  it("refuses an answer that is not in the expected shape, rather than showing a blank page", () => {
    expect(() => parseRawCounts(null)).toThrow("expected shape");
    expect(() => parseRawCounts({ team: counts(), people: "x" })).toThrow("expected shape");
    expect(() => parseRawCounts({ team: { ...counts(), approved: 0.5 }, people: [] })).toThrow("expected shape");
    expect(() => parseRawCounts({ team: counts(), people: [{ owner: "a", all: counts(), kinds: [{ kind: "task" }] }] })).toThrow("expected shape");
  });
});

function fakePlugin(over: Partial<PluginApi> = {}): PluginApi {
  const unused = async () => {
    throw new Error("not used here");
  };
  return {
    handoverStatus: async (email: string): Promise<HandoverStatus> => (email === "ana@example.com" ? { ok: true, email, timezone: "UTC", handoverStartHour: 22, handovers: [] } : { ok: false, message: "you are not on the team" }),
    counts: async () => parseRawCounts(RAW),
    eventsCsv: async () => "task id,owner\r\nt1,ana@example.com\r\n",
    numbersCsv: async () => "Date,Owner\r\n",
    pendingEmails: unused, markSent: unused, preview: unused, execute: unused, publishResult: unused, waitingPullRequests: unused, pullRequestUpdate: unused,
    createInvite: unused, previewInvite: unused, claimInvite: unused, startHandover: unused, numbers: unused, finishInvite: unused, stuckApprovals: unused, recoverApproval: unused,
    ...over,
  } as unknown as PluginApi;
}

let server: ReturnType<typeof createLinkServer> | null = null;
afterEach(() => server?.close());
async function start(api: PluginApi, deps: Parameters<typeof createLinkServer>[2] = {}): Promise<string> {
  server = createLinkServer(api, () => {}, deps);
  await new Promise<void>((r) => server!.listen(0, "127.0.0.1", r));
  return `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
}
const session = { whoIs: async (cookie: string) => (cookie.includes("ana") ? { email: "ana@example.com" } : cookie.includes("zed") ? { email: "zed@example.com" } : null) };

describe("the numbers page", () => {
  it("asks anyone not signed in to sign in, and shows nothing", async () => {
    const base = await start(fakePlugin(), { session, signInUrl: "https://team.example.com" });
    const res = await fetch(`${base}/numbers`);
    expect(res.status).toBe(401);
    const html = await res.text();
    expect(html).toContain("sign in to Paperclip");
    expect(html).not.toContain("ana@example.com");
  });

  it("refuses a signed-in person who is not on the team", async () => {
    const base = await start(fakePlugin(), { session });
    const res = await fetch(`${base}/numbers`, { headers: { cookie: "s=zed" } });
    expect(res.status).toBe(403);
    expect(await res.text()).not.toContain("ana@example.com");
  });

  it("shows a team member the counts per person and per task kind, and no percentage", async () => {
    const base = await start(fakePlugin(), { session });
    const res = await fetch(`${base}/numbers`, { headers: { cookie: "s=ana" } });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("<title>Numbers</title>");
    for (const c of [...MAIN_COLUMNS, ...FLAG_COLUMNS]) expect(html).toContain(`<th>${c.label}</th>`);
    expect(html).toContain("<td>bo@example.com</td>");
    expect(html).toContain("task kind: handoff");
    const visible = html.replace(/<style>[\s\S]*?<\/style>/, "").replace("no percentages", "");
    expect(visible).not.toMatch(/%|percent|yield|average|median/i);
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("is read-only: only GET", async () => {
    const base = await start(fakePlugin(), { session });
    const res = await fetch(`${base}/numbers`, { method: "POST", headers: { cookie: "s=ana" } });
    expect(res.status).toBe(405);
  });

  it("says so, and does not crash, when the plugin cannot give counts", async () => {
    const base = await start(fakePlugin({ counts: async () => { throw new PaperclipError(404, "x"); } }), { session });
    const res = await fetch(`${base}/numbers`, { headers: { cookie: "s=ana" } });
    expect(res.status).toBe(502);
    expect(await res.text()).toContain("vt-update");
  });

  it("is off when the server has no sign-in check", async () => {
    const base = await start(fakePlugin());
    expect((await fetch(`${base}/numbers`)).status).toBe(503);
  });
});

function io() {
  const r = { out: "", err: "", files: new Map<string, string>() };
  const cli: CliIo = { out: (t) => void (r.out += t), err: (t) => void (r.err += t), writeFile: (f, t) => void r.files.set(f, t) };
  return { r, cli };
}

describe("vt-numbers", () => {
  it("with no arguments prints the raw counts and writes nothing", async () => {
    const { r, cli } = io();
    expect(await runNumbers(fakePlugin(), [], cli)).toBe(0);
    expect(r.out).toContain("Raw counts from the event log. Counts only: no percentages.");
    expect(r.out).toContain("Team (everyone)");
    expect(r.files.size).toBe(0);
  });

  it("--events FILE also writes the event log", async () => {
    const { r, cli } = io();
    expect(await runNumbers(fakePlugin(), ["--events", "/tmp/e.csv"], cli)).toBe(0);
    expect(r.files.get("/tmp/e.csv")).toBe("task id,owner\r\nt1,ana@example.com\r\n");
    expect(r.out).toContain("Team (everyone)");
    expect(r.err).toContain("Event log written to /tmp/e.csv.");
  });

  it("--events - sends only the CSV to standard output, so it can be redirected", async () => {
    const { r, cli } = io();
    expect(await runNumbers(fakePlugin(), ["--events", "-"], cli)).toBe(0);
    expect(r.out).toBe("task id,owner\r\nt1,ana@example.com\r\n");
    expect(r.err).toContain("Team (everyone)");
  });

  it("the earlier form, a bare file name, still writes the measurement sheet", async () => {
    const { r, cli } = io();
    expect(await runNumbers(fakePlugin(), ["numbers.csv"], cli)).toBe(0);
    expect(r.files.get("numbers.csv")).toBe("Date,Owner\r\n");
  });

  it("refuses what it does not understand", async () => {
    const { r, cli } = io();
    expect(await runNumbers(fakePlugin(), ["--percent"], cli)).toBe(2);
    expect(r.err).toContain('I do not understand "--percent"');
    expect(await runNumbers(fakePlugin(), ["--events"], cli)).toBe(2);
  });

  it("tells the admin what to do when the plugin on the server is too old", async () => {
    const { r, cli } = io();
    const api = fakePlugin({ counts: async () => { throw new PaperclipError(404, "Paperclip answered 404 for /counts"); } });
    expect(await runNumbers(api, [], cli)).toBe(1);
    expect(r.err).toContain("sudo vt-update");
    expect(r.out).toBe("");
  });
});

describe("plugin api: counts and events", () => {
  it("asks the board-only routes and checks the shape", async () => {
    const seen: string[] = [];
    const fake = (async (url: string) => {
      seen.push(String(url));
      return new Response(JSON.stringify(String(url).includes("/events/csv") ? { csv: "task id\r\n" } : RAW), { status: 200 });
    }) as unknown as typeof fetch;
    const api = paperclipApi({ paperclipUrl: "http://pc", plugin: "p", companyId: "co", paperclipApiKey: null } as never, fake);
    expect((await api.counts()).team.handedOver).toBe(5);
    expect(await api.eventsCsv()).toBe("task id\r\n");
    expect(seen).toEqual(["http://pc/api/plugins/p/api/counts?companyId=co", "http://pc/api/plugins/p/api/events/csv?companyId=co"]);
  });
});
