// Confidence reducers. Trace ops aggregate per-hop confidence into a path-level one;
// the path is only as trustworthy as its weakest hop (ARCHITECTURE.md §3.3).
//
// Severity order (best → worst): certain → partial → dynamic → unresolved.
// `dynamic` outranks `partial` in badness because a dynamic hop means the link itself
// was only observable through runtime dispatch; `unresolved` is worst — we could not
// establish the link at all.

import type { Confidence } from '../../core/span.ts';

const SEVERITY: Record<Confidence, number> = {
  certain: 0,
  partial: 1,
  dynamic: 2,
  unresolved: 3,
};

void atLeast; // reducer reserved for per-hop trace aggregation (Phase 6)

export function worstOf(confidences: readonly Confidence[]): Confidence {
  let worst: Confidence = 'certain';
  for (const c of confidences) {
    const severity = SEVERITY[c];
    if (severity > SEVERITY[worst]) worst = c;
  }
  return worst;
}

/** True when `a` is at least as trustworthy as `b`. */
function atLeast(a: Confidence, b: Confidence): boolean {
  return SEVERITY[a] <= SEVERITY[b];
}
