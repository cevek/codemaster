// Idle self-exit hard deadline for the long-lived `mcp` server (spec-daemon-singleton §6,
// Stage 1). A stdio MCP server whose stdin-EOF never arrives (a missed EOF, a leaked stdin
// write-end, a heavy sync LS call that delays the queued EOF) has no idle deadline today, so
// it lives forever — the field saw 26 such orphans. This bounds an orphan's lifetime to the
// configured TTL: a deadline timer armed only while NO request is in flight; a request entry
// cancels it, completion re-arms it.
//
// Scope, stated honestly (§1, §3.6): the timer fires only once the event loop is free to run
// timers — so it reaps a missed/leaked or transiently-blocked-then-freed EOF, NOT a
// permanently-wedged synchronous loop (that needs Stage 2's process isolation + kill-on-deadline).
// It NEVER fires mid-request — killing a live agent call is worse than an orphan.

import type { Clock, CancelTimer } from '../common/async/clock.ts';

export interface IdleExit {
  /** Request entry: cancel the pending deadline and mark one request in flight. */
  enter(): void;
  /** Request completion (MUST run in a `finally`, even on a throwing path): mark done; re-arm
   *  the deadline iff nothing else is in flight. A stranded count would block exit forever. */
  leave(): void;
  /** Arm the initial deadline after connect — a server that connects and never receives a
   *  request still self-exits. No-op while a request is already in flight. */
  start(): void;
  /** Cancel any pending deadline (the clean-shutdown path, so it can't race the exit). */
  stop(): void;
}

export function createIdleExit(opts: {
  clock: Clock;
  idleMs: number;
  onIdle: () => void;
}): IdleExit {
  let inFlight = 0;
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
      // Belt-and-suspenders: a request could have entered between the timer firing and this
      // callback running on the loop — never reap a live call.
      if (inFlight > 0 || fired) return;
      fired = true;
      opts.onIdle();
    });
  };

  return {
    enter() {
      inFlight += 1;
      disarm();
    },
    leave() {
      if (inFlight > 0) inFlight -= 1;
      if (inFlight === 0) arm();
    },
    start() {
      if (inFlight === 0) arm();
    },
    stop() {
      disarm();
    },
  };
}
