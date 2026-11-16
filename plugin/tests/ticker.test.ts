import { AsyncLocalStorage } from "node:async_hooks";
import { describe, expect, it } from "vitest";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { listCompanies } from "../src/handoverrunner.js";
import { startTicker } from "../src/ticker.js";

describe("startTicker", () => {
  it("runs work outside the caller's async context", async () => {
    const invocation = new AsyncLocalStorage<string>();
    const seen: Array<string | undefined> = [];
    const ticker = startTicker(async () => {
      seen.push(invocation.getStore());
    });
    await invocation.run("job-invocation", () => ticker.kick());
    expect(seen).toEqual([undefined]);
    ticker.stop();
  });

  it("reports failures to the caller and keeps running", async () => {
    let n = 0;
    const ticker = startTicker(async () => {
      n += 1;
      if (n === 1) throw new Error("boom");
    });
    await expect(ticker.kick()).rejects.toThrow("boom");
    await expect(ticker.kick()).resolves.toBeUndefined();
    ticker.stop();
  });

  it("serves kicks that arrive while work is running", async () => {
    let n = 0;
    const ticker = startTicker(async () => {
      n += 1;
      await new Promise((r) => setTimeout(r, 10));
    });
    await Promise.all([ticker.kick(), ticker.kick(), ticker.kick()]);
    expect(n).toBeGreaterThanOrEqual(1);
    expect(n).toBeLessThanOrEqual(3);
    ticker.stop();
  });
});

describe("listCompanies", () => {
  const ctxWith = (list: () => Promise<Array<{ id: string }>>) => ({ companies: { list } }) as unknown as PluginContext;
  const noPause = async () => undefined;

  it("retries when Paperclip refuses the call because another request is in flight", async () => {
    let calls = 0;
    const ctx = ctxWith(async () => {
      calls += 1;
      if (calls < 3) throw new Error("the worker referenced a missing, expired, or unknown invocation scope");
      return [{ id: "co-1" }];
    });
    expect(await listCompanies(ctx, noPause)).toEqual([{ id: "co-1" }]);
    expect(calls).toBe(3);
  });

  it("falls back to the last list that worked, and fails only when there is none", async () => {
    await listCompanies(ctxWith(async () => [{ id: "co-2" }]), noPause);
    const refusing = ctxWith(async () => {
      throw new Error("invalid invocation scope");
    });
    expect(await listCompanies(refusing, noPause)).toEqual([{ id: "co-2" }]);
  });
});
