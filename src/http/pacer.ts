/**
 * Keeps the CLI at a low, steady pace: at most `ratePerSecond` requests per second for the whole
 * process, retries included. The API's own limits are per minute and per user (the panel shares
 * them), so the default is well under them.
 */
export type Sleep = (ms: number, signal?: AbortSignal) => Promise<void>;

export const DEFAULT_RATE = 1;
export const MAX_RATE = 10;

export class Pacer {
  readonly intervalMs: number;
  #next = 0;

  constructor(
    ratePerSecond: number,
    private readonly clock: () => number,
    private readonly sleep: Sleep,
  ) {
    this.intervalMs = 1000 / ratePerSecond;
  }

  async wait(signal?: AbortSignal): Promise<void> {
    const now = this.clock();
    const start = Math.max(now, this.#next);
    this.#next = start + this.intervalMs;
    if (start > now) await this.sleep(start - now, signal);
  }
}

/** `setTimeout` as a promise, cancelled by `signal`. */
export const realSleep: Sleep = (ms, signal) =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('aborted'));
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error('aborted'));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
