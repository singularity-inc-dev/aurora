/** Where a person is in their daily schedule: planning hours, then the handover window. */
export type HandoverPhase = "day" | "proposal" | "window";

export interface HandoverClock {
  phase: HandoverPhase;
  /** Local calendar date (YYYY-MM-DD) on which this person's scheduled handover starts: its key. */
  handoverKey: string;
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
 * Where a person is in their daily schedule. The handover window runs from `handoverStartHour`
 * (local time) for `lengthHours`; the evening plan opens `leadHours` before it.
 */
export function handoverClock(now: Date, timeZone: string, handoverStartHour: number, leadHours: number, lengthHours: number): HandoverClock {
  const local = localParts(now, timeZone);
  const sinceStart = (local.minutes - handoverStartHour * 60 + 1440) % 1440;
  const minuteFloor = now.getTime() - (now.getTime() % MINUTE);

  if (sinceStart < lengthHours * 60) {
    const startsAt = new Date(minuteFloor - sinceStart * MINUTE);
    return {
      phase: "window",
      handoverKey: localParts(startsAt, timeZone).date,
      startsAt,
      endsAt: new Date(startsAt.getTime() + lengthHours * 60 * MINUTE),
    };
  }
  const untilStart = 1440 - sinceStart;
  const startsAt = new Date(minuteFloor + untilStart * MINUTE);
  return {
    phase: untilStart <= leadHours * 60 ? "proposal" : "day",
    handoverKey: localParts(startsAt, timeZone).date,
    startsAt,
    endsAt: new Date(startsAt.getTime() + lengthHours * 60 * MINUTE),
  };
}
