// A wall-clock deadline over the `Clock` seam (ARCHITECTURE.md §1 never-hang, §19). A
// synchronous, poll-able budget: `expired()` compares `clock.now()` against a fixed target,
// so it works INSIDE a blocking synchronous call (a TS `findReferences`, a BFS loop) where an
// async `withTimeout` race cannot help — the timer would never fire while the sync work holds
// the event loop. Pure: it touches only the injected `Clock`, so a test advances a manual
// clock and the expiry is deterministic (§16, no sleep).
//
// This is the COOPERATIVE half of never-hang: an op/loop polls it and degrades to an honest
// `ToolFailure{tool:'timeout'}` (or a `partial` when data was accumulated). It does NOT
// interrupt uncancellable work (a TS program build, codemaster's own sync) — that is the
// process-mode kill-on-deadline backstop (§9). The cooperative budget is deliberately SHORTER
// than that hard kill, so the graceful partial always returns first.

import type { Clock } from './clock.ts';

export interface Deadline {
  /** True once the wall-clock budget is spent — poll it at loop boundaries and inside the LS
   *  cancellation token. Monotonic: once true it stays true (the clock only moves forward). */
  expired(): boolean;
  /** Milliseconds left before expiry (0 once spent). `Infinity` for `NO_DEADLINE`. */
  remainingMs(): number;
}

/** A deadline `budgetMs` from now (measured against `clock`). A non-positive budget is
 *  ALREADY expired — the first poll degrades, which is exactly how a timeout test forces the
 *  path deterministically. */
export function createDeadline(clock: Clock, budgetMs: number): Deadline {
  const at = clock.now() + budgetMs;
  return {
    expired: () => clock.now() >= at,
    remainingMs: () => Math.max(0, at - clock.now()),
  };
}

/** The never-expiring deadline — the honest "unbounded" default for a context that has no
 *  budget wired (so `OpContext.deadline` is always present, never an `undefined` an op must
 *  guard). */
export const NO_DEADLINE: Deadline = {
  expired: () => false,
  remainingMs: () => Infinity,
};
