import { AsyncLocalStorage } from "node:async_hooks";
import { describe, expect, it } from "vitest";
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
