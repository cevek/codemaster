// The `Clock` seam — the single sanctioned source of "time" below the daemon
// (ARCHITECTURE.md §5-L0.5, §16 determinism). Tests inject a manual clock and advance
// it explicitly; nothing in the system calls `Date.now`/`setTimeout` directly, so
// scenario tests never sleep.

export type CancelTimer = () => void;

export interface Clock {
  /** Current time in epoch milliseconds. */
  now(): number;
  /** Run `fn` after `ms`. Returns a cancel function. Never throws from `fn` into the
   *  scheduler — callers wrap their own callbacks. */
  schedule(ms: number, fn: () => void): CancelTimer;
}

/** The real clock. Timers are `unref`ed so a pending timer never holds the process
 *  open past its work (the daemon's own keep-alive is its server socket). */
export const systemClock: Clock = {
  now: () => Date.now(),
  schedule(ms, fn) {
    const timer = setTimeout(fn, ms);
    timer.unref();
    return () => clearTimeout(timer);
  },
};
