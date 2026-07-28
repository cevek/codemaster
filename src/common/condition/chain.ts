// The domain-neutral enclosing-CONDITION contract (t-933867) — the shape a per-site condition
// annotation carries and its ONE rendering, shared by the producer (`plugins/ts`), the sql
// projection (`ops/`) and the dense renderer (`format/`). It lives here, not in the ts plugin,
// precisely so those three cannot disagree about what a chain means: `format/` may import
// `common/` but never `plugins/`, so a plugin-side renderer would have to be MIRRORED there —
// and a mirrored renderer is a second oracle waiting to drift (§3.1). Same reason
// `common/trace/` owns the trace-hop contract.

/** The enclosing conditional-branch chain of one site, outermost → innermost. Each entry is
 *  ready-to-read text with the branch's POLARITY already applied (an `else` / `whenFalse` /
 *  `||`-RHS branch reads `!(cond)`); the producer decides what counts as a branch.
 *
 *  The two "empty" forms are DIFFERENT claims and must stay distinguishable end to end:
 *  `conditions: []` is the MEASURED "no enclosing branch condition"; an ABSENT chain means
 *  "not annotated" (the opt-in flag off / a row that is not a per-site view). `partial` marks a
 *  chain with at least one condition the producer could not state soundly — disclosed as a
 *  leading `…`, never silently dropped (§3.4). An empty chain NEVER means "runs
 *  unconditionally": preconditions outside the syntactic scope (an early `return`, a
 *  conditionally-invoked caller) are not part of this claim. */
export type ConditionChain = { conditions: string[]; partial?: true };

/** The one-line / one-cell form: `a && !(b)`, prefixed `…` when a condition above is unstated.
 *  `''` is the measured empty chain — a consumer distinguishes it from "not annotated" by the
 *  field's presence, never by this string. */
export function renderConditionChain(chain: ConditionChain): string {
  const body = chain.conditions.join(' && ');
  if (chain.partial !== true) return body;
  return body.length > 0 ? `… && ${body}` : '…';
}
