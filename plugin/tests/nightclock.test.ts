import { describe, expect, it } from "vitest";
import { nightClock } from "../src/nightclock.js";

const at = (iso: string) => new Date(iso);

describe("nightClock", () => {
  it("is day well before the evening plan", () => {
    expect(nightClock(at("2026-10-21T12:00:00Z"), "UTC", 22, 2, 8)).toMatchObject({ phase: "day", nightDate: "2026-10-21" });
  });

  it("opens the evening plan lead hours before night start", () => {
    const c = nightClock(at("2026-10-21T20:30:00Z"), "UTC", 22, 2, 8);
    expect(c).toMatchObject({ phase: "proposal", nightDate: "2026-10-21" });
    expect(c.startsAt.toISOString()).toBe("2026-10-21T22:00:00.000Z");
  });

  it("is night from the start hour, including after midnight", () => {
    expect(nightClock(at("2026-10-21T22:00:00Z"), "UTC", 22, 2, 8)).toMatchObject({ phase: "night", nightDate: "2026-10-21" });
    const late = nightClock(at("2026-10-22T03:15:00Z"), "UTC", 22, 2, 8);
    expect(late).toMatchObject({ phase: "night", nightDate: "2026-10-21" });
    expect(late.endsAt.toISOString()).toBe("2026-10-22T06:00:00.000Z");
  });

  it("uses the person's own timezone", () => {
    // 21:00 UTC is 23:00 in Berlin (summer time) -> night for a 22:00 start.
    expect(nightClock(at("2026-07-01T21:00:00Z"), "Europe/Berlin", 22, 2, 8)).toMatchObject({ phase: "night", nightDate: "2026-07-01" });
    // Same instant is 17:00 in New York -> still day.
    expect(nightClock(at("2026-07-01T21:00:00Z"), "America/New_York", 22, 2, 8).phase).toBe("day");
  });

  it("handles a night that starts just after midnight", () => {
    const c = nightClock(at("2026-10-21T23:30:00Z"), "UTC", 1, 2, 6);
    expect(c).toMatchObject({ phase: "proposal", nightDate: "2026-10-22" });
  });
});
