/**
 * Time limits and retries for every outside call (Paperclip, git, the agent).
 * Paperclip's SDK already gives up on a host call after 30 seconds; git and
 * whole ticks need their own limit, and a call that failed once is retried
 * with growing pauses.
 *
 * Only retry calls that are safe to repeat (reads, setting a status, pausing).
 * A time-out can hide a success, so creating a ticket or a comment is never
 * retried: it could appear twice.
 */

export class TimedOut extends Error {
  constructor(label: string, ms: number) {
    super(`${label} timed out after ${ms} ms`);
    this.name = "TimedOut";
  }
}

/** Reject if `promise` has not settled within `ms`. The work itself cannot be cancelled; it is only no longer waited for. */
export function withTimeout<T>(promise: Promise<T>, ms: number, label = "step"): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const limit = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new TimedOut(label, ms)), ms);
  });
  return Promise.race([promise, limit]).finally(() => clearTimeout(timer));
}

export interface RetryOptions {
  /** Tries in all, including the first (default 3). */
  attempts?: number;
  /** Pause before the second try; doubles each time (default 500 ms). */
  baseDelayMs?: number;
  /** Longest pause (default 8 s). */
  maxDelayMs?: number;
  /** Limit for each try (default: none beyond the call's own). */
  timeoutMs?: number;
  label?: string;
  sleep?: (ms: number) => Promise<void>;
}

const realSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Run `fn`, retrying with exponential backoff; throws the last error. */
export async function retrying<T>(fn: () => Promise<T>, options: RetryOptions = {}): Promise<T> {
  const attempts = Math.max(1, options.attempts ?? 3);
  const base = options.baseDelayMs ?? 500;
  const max = options.maxDelayMs ?? 8000;
  const sleep = options.sleep ?? realSleep;
  let last: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const run = fn();
      return await (options.timeoutMs ? withTimeout(run, options.timeoutMs, options.label) : run);
    } catch (err) {
      last = err;
      if (attempt < attempts) await sleep(Math.min(max, base * 2 ** (attempt - 1)));
    }
  }
  throw last;
}
