// The single owner of the display-list `.slice(0, cap)` idiom (§3.4): cap a result-set list and
// CO-PRODUCE its canonical `Truncation {shown,total,hint}` envelope at the cut, so a capped array
// can never be shipped without its honesty channel. Unlike `elideType`, the cap here is a RUNTIME
// value (a user `limit` / the sql `tableRowBound`), so there is no `CapId` registry — the caller
// passes the cap and the recovery hint. `cap === undefined` means "no cap" (sql-mode uncapped).

import type { Truncation } from '../../core/result.ts';

/** A capped list plus, when a cut happened, its `Truncation`. `shown` is the (possibly cut) array;
 *  `truncation` is `undefined` when nothing was dropped (the common case ships no envelope). */
export interface Capped<T> {
  shown: T[];
  truncation?: Truncation;
}

/** Slice `items` to `cap`, producing the §3.4 `Truncation` iff the cut dropped rows. `total` is the
 *  PRE-slice length (a count-only consumer sees the real size); `hint` states how to get the rest.
 *  `cap === undefined` returns the whole list uncapped (never a silent partial). */
export function capList<T>(items: readonly T[], cap: number | undefined, hint: string): Capped<T> {
  if (cap === undefined || items.length <= cap) return { shown: [...items] };
  return { shown: items.slice(0, cap), truncation: { shown: cap, total: items.length, hint } };
}
