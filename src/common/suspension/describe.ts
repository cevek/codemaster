// The one phrasing of "this window spanned a system sleep", shared by every timeout cause that can
// be overtaken by one (the process-host kill, the bridge's reply deadline).

import { suspendedWithin, type Suspension } from './overlap.ts';

const secs = (ms: number): string => `${Math.round(ms / 1000)}s`;

/** `undefined` when the window did not overlap the last sleep. `deadlineMs` names the budget that
 *  ran out: only when the awake time is provably under it is the sleep the explanation — the overlap
 *  is a floor, so above it the sleep is stated but no conclusion is drawn from it. */
export function suspensionNote(
  startMs: number,
  endMs: number,
  s: Suspension | undefined,
  deadlineMs?: number,
): string | undefined {
  if (s === undefined) return undefined;
  const slept = suspendedWithin(startMs, endMs, s);
  if (slept <= 0) return undefined;
  const awake = endMs - startMs - slept;
  const woke = new Date(s.wokeAtMs).toISOString().slice(11, 19);
  const head = `the machine slept ≥${secs(slept)} of this ${secs(endMs - startMs)} window (woke ${woke}Z), so the work was awake ≤${secs(awake)}`;
  return deadlineMs !== undefined && awake < deadlineMs
    ? `${head} — the deadline ran out during sleep; a retry is not expected to time out for this reason`
    : head;
}
