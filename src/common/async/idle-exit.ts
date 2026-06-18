// A generic idle self-exit deadline over the `Clock` seam (ARCHITECTURE.md §5-L0.5). A timer
// armed only while NO "hold" is active; acquiring a hold cancels it, releasing the last one
// re-arms it. On expiry it fires `onIdle` exactly once — and NEVER while a hold is active.
//
// Two consumers model "hold" differently (spec-daemon-singleton §6):
//   - the Stage-1 `mcp` server (`mcp/server.ts`): a hold = an in-flight request, so the server
//     can't be reaped mid-call (killing a live agent call is worse than an orphan);
//   - the Stage-2 daemon (`daemon/daemon-server.ts`): a hold = an open bridge connection, so the
//     daemon idle-exits only when the last bridge disconnects.
//
// Scope, stated honestly (§1, §3.6): the timer fires only once the event loop is free to run
// timers — so it reaps a missed/leaked or transiently-blocked-then-freed idle, NOT a permanently
// wedged synchronous loop (that needs process isolation + kill-on-deadline).

import type { Clock, CancelTimer } from './clock.ts';

export interface IdleExit {
  /** Acquire a hold: cancel the pending deadline and count one more. */
  enter(): void;
  /** Release a hold (MUST run in a `finally`, even on a throwing path): re-arm the deadline iff
   *  nothing else holds it. A stranded count would block exit forever. */
  leave(): void;
  /** Arm the initial deadline — a consumer that acquires no hold still self-exits after the TTL.
   *  No-op while a hold is already active. */
  start(): void;
  /** Cancel any pending deadline (the clean-shutdown path, so it can't race the exit). */
  stop(): void;
}

export function createIdleExit(opts: {
  clock: Clock;
  idleMs: number;
  onIdle: () => void;
}): IdleExit {
  let holds = 0;
  let cancel: CancelTimer | undefined;
  let fired = false;

  const disarm = (): void => {
    cancel?.();
    cancel = undefined;
  };
  const arm = (): void => {
    disarm();
    if (fired) return;
    cancel = opts.clock.schedule(opts.idleMs, () => {
      cancel = undefined;
      // Belt-and-suspenders: a hold could have been acquired between the timer firing and this
      // callback running on the loop — never reap while something is held.
      if (holds > 0 || fired) return;
      fired = true;
      opts.onIdle();
    });
  };

  return {
    enter() {
      holds += 1;
      disarm();
    },
    leave() {
      if (holds > 0) holds -= 1;
      if (holds === 0) arm();
    },
    start() {
      if (holds === 0) arm();
    },
    stop() {
      disarm();
    },
  };
}
