// How much of a wall-clock window the machine spent asleep. Node's timers and `Date.now` both keep
// running across a darwin system sleep (libuv's clock there includes it), so a deadline armed before
// a sleep fires on wake and a duration spanning one counts it — a "timeout after 150 s" may describe a
// process that ran for 10 (t-833715). The kernel only exposes the LAST sleep/wake pair, so a window
// containing several cycles sees only the latest: the overlap is a floor, never an exact figure.

export interface Suspension {
  sleptAtMs: number;
  wokeAtMs: number;
}

/** Milliseconds of `[startMs, endMs]` covered by `s`; 0 when they do not intersect. A floor. */
export function suspendedWithin(startMs: number, endMs: number, s: Suspension): number {
  const from = Math.max(startMs, s.sleptAtMs);
  const to = Math.min(endMs, s.wokeAtMs);
  return to > from ? to - from : 0;
}
