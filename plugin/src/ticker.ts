/**
 * Runs `work` in a loop started from setup(), outside any host invocation.
 *
 * Paperclip only lets a worker make company-scoped calls outside an invocation
 * (for the companies it is configured in); a scheduled job's invocation has no
 * company, so `config.get(companyId)` is refused inside it. The job therefore
 * only kicks this loop and waits for the result. Promise continuations resume in
 * the loop's own async context, so the work never inherits the job's invocation.
 */
export interface Ticker {
  /** Ask for one run of `work` and wait until it has finished. */
  kick(): Promise<void>;
  stop(): void;
}

export function startTicker(work: () => Promise<void>): Ticker {
  let waiters: Array<(err?: unknown) => void> = [];
  let wake: () => void = () => {};
  let stopped = false;

  void (async () => {
    while (!stopped) {
      await new Promise<void>((resolve) => {
        wake = resolve;
        if (waiters.length > 0) resolve();
      });
      if (stopped) break;
      const batch = waiters;
      waiters = [];
      let error: unknown;
      try {
        await work();
      } catch (err) {
        error = err;
      }
      for (const done of batch) done(error);
    }
  })();

  return {
    kick() {
      return new Promise<void>((resolve, reject) => {
        waiters.push((err) => (err === undefined ? resolve() : reject(err)));
        wake();
      });
    },
    stop() {
      stopped = true;
      wake();
    },
  };
}
