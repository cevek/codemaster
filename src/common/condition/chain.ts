// The domain-neutral enclosing-CONDITION contract (t-933867) — the shape a per-site condition
// annotation carries, the text budget its predicates obey, and its ONE rendering, shared by the
// producer (`plugins/ts`), the sql projection (`ops/`) and the dense renderer (`format/`). It lives
// here, not in the ts plugin, precisely so those three cannot disagree about what a chain means:
// `format/` may import `common/` but never `plugins/`, so a plugin-side renderer would have to be
// MIRRORED there — and a mirrored renderer is a second oracle that needs an explicit cross-pin to
// stay honest (the `summarizeQueryKey`/`renderKey` pair in `format/render/shapes/helpers.ts` is that
// fallback, for a shape whose home type must stay in `plugins/`); a `common/`-owned contract needs no
// pin at all. Same reason `common/trace/` owns the trace-hop contract.

/** The enclosing conditional-branch chain of one site, outermost → innermost. Each entry is
 *  ready-to-read text with the branch's POLARITY already applied (an `else` / `whenFalse` /
 *  `||`-RHS branch reads `!(cond)`); the producer decides what counts as a branch.
 *
 *  The two "empty" forms are DIFFERENT claims and must stay distinguishable end to end:
 *  `conditions: []` is the MEASURED "no enclosing branch"; an ABSENT chain means "not annotated"
 *  (the opt-in flag off / a row that is not a per-site view). `partial` marks a chain that is a
 *  SUBSET — a branch the producer could not state soundly, or an annotation it could not finish for
 *  that site — disclosed as a leading `<unstated>`, never silently dropped (§3.4). An empty chain
 *  NEVER means "runs unconditionally": preconditions outside the syntactic scope (an early
 *  `return`, a conditionally-invoked caller) are not part of this claim. */
export type ConditionChain = { conditions: string[]; partial?: true };

/** Per-predicate text budget. Owned here rather than by the producer because it is what makes a
 *  rendered chain bounded for BOTH faces (§12 token cost); the cut leaves the `…` marker
 *  `common/truncate` owns, and that marker is TRAILING — distinct from the leading subset marker. */
export const CONDITION_TEXT_CAP = 90;

/** The leading element that discloses a chain is a subset. A word in the repo's `<dyn>`/`<opaque>`
 *  idiom rather than a bare `…`, because `…` already means "this predicate was cut" (trailing) and
 *  "extra destructured props" elsewhere — one glyph for three claims is unreadable. */
const UNSTATED = '<unstated>';

/** The one-line / one-cell form: `a && !(b)`, prefixed `<unstated>` when a branch above is not
 *  stated. `emptyLabel` is the token for the MEASURED empty chain and is the one thing the two faces
 *  spell differently BY DESIGN — the default `''` is what makes the sql predicate `condition <> ''`
 *  work, while the dense line passes a readable word. Both spellings are decided here so neither
 *  face owns half the contract. A consumer distinguishes "measured empty" from "not annotated" by
 *  the field's PRESENCE, never by this string. */
export function renderConditionChain(chain: ConditionChain, emptyLabel = ''): string {
  const body = chain.conditions.join(' && ');
  if (chain.partial !== true) return body.length > 0 ? body : emptyLabel;
  return body.length > 0 ? `${UNSTATED} && ${body}` : UNSTATED;
}
