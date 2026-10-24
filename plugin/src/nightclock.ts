export type NightPhase = "day" | "proposal" | "night";

export interface NightClock {
  phase: NightPhase;
  /** Local calendar date (YYYY-MM-DD) on which this person's night starts. */
  nightDate: string;
  startsAt: Date;
  endsAt: Date;
}

const MINUTE = 60_000;

function localParts(date: Date, timeZone: string): { date: string; minutes: number } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "00";
  return { date: `${get("year")}-${get("month")}-${get("day")}`, minutes: Number(get("hour")) * 60 + Number(get("minute")) };
}

/**
 * Where a person is in their daily cycle. The night runs from `nightStartHour`
 * (local time) for `lengthHours`; the evening plan opens `leadHours` before it.
 */
export function nightClock(now: Date, timeZone: string, nightStartHour: number, leadHours: number, lengthHours: number): NightClock {
  const local = localParts(now, timeZone);
  const sinceStart = (local.minutes - nightStartHour * 60 + 1440) % 1440;
  const minuteFloor = now.getTime() - (now.getTime() % MINUTE);

  if (sinceStart < lengthHours * 60) {
    const startsAt = new Date(minuteFloor - sinceStart * MINUTE);
    return {
      phase: "night",
      nightDate: localParts(startsAt, timeZone).date,
      startsAt,
      endsAt: new Date(startsAt.getTime() + lengthHours * 60 * MINUTE),
    };
  }
  const untilStart = 1440 - sinceStart;
  const startsAt = new Date(minuteFloor + untilStart * MINUTE);
  return {
    phase: untilStart <= leadHours * 60 ? "proposal" : "day",
    nightDate: localParts(startsAt, timeZone).date,
    startsAt,
    endsAt: new Date(startsAt.getTime() + lengthHours * 60 * MINUTE),
  };
}
