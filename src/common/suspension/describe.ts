// The one phrasing of "this window spanned a system sleep", shared by every timeout cause that can
// be overtaken by one (the process-host kill, the bridge's reply deadline).

import { suspendedWithin, type Suspension } from './overlap.ts';

/** `undefined` when the window did not overlap the last sleep. `deadlineMs` names the budget that
 *  ran out: the sleep is blamed only when the moment it ran out (`startMs + deadlineMs`) lies inside
 *  the sleep — a short sleep earlier in the window leaves a deadline that ran out awake, and the
 *  overlap alone cannot tell the two apart. Rounding keeps both bounds true: the sleep down, the
 *  awake time up. */
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
  const woke = new Date(s.wokeAtMs).toISOString().replace(/\.\d+Z$/, 'Z');
  const head = `the machine slept ≥${Math.floor(slept / 1000)}s of this ${Math.round((endMs - startMs) / 1000)}s window (woke ${woke}), so the work was awake ≤${Math.ceil(awake / 1000)}s`;
  const expiredAt = deadlineMs === undefined ? undefined : startMs + deadlineMs;
  return expiredAt !== undefined && expiredAt >= s.sleptAtMs && expiredAt <= s.wokeAtMs
    ? `${head} — the deadline ran out during sleep; a retry is not expected to time out for this reason`
    : head;
}
