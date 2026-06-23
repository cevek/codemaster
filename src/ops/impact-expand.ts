// The shared `UsagesView → ExpandOutcome` projection both `impact` (reference closure) and
// `impact_type_error` (type-error blast radius) feed into `buildClosure`'s `Expand` callback.
// One projection, so the two ops compute the SAME dependent set — the decl-only drop, the
// hub-truncation `groupTotal` shrink, and the callable-nature (value-flow boundary) verdict
// are honesty-load-bearing (§3.3/§3.4) and must never drift between the two callers.

import type { GroupRow, UsagesView } from '../plugins/ts/query-types.ts';
import { rolesDeclOnly, rolesIncludeCallable } from './impact-closure.ts';

/** Definition kinds whose value-only read is a meaningful dynamic-dispatch escape (a thing
 *  that is normally invoked/constructed). An arrow-bound `const` reads as kind `const`, so
 *  this is paired with a sibling call/jsx check — see `outcomeFromView`. */
const CALLABLE_KINDS = new Set(['function', 'local function', 'method', 'class', 'constructor']);

/** Project a `find_usages` grouped view into an `ExpandOutcome`: drop the target's own
 *  decl-only rollup (its definition site is not a dependent), shrink `groupTotal` by the
 *  same count so the drop never looks like a hub truncation, and decide callable-nature
 *  from the parent's kind OR a sibling that calls/renders it. */
export function outcomeFromView(view: UsagesView): {
  ok: true;
  enclosers: readonly GroupRow[];
  groupTotal: number;
  callableNatured: boolean;
} {
  const all = view.groups ?? [];
  const enclosers = all.filter((g) => !rolesDeclOnly(g.roles));
  const droppedDecl = all.length - enclosers.length;
  // `callable` (call/construct signature) catches an arrow/fn-expr `const` the kind check misses
  // (its LS kind is `const`) — without it, a value-only-read of such a callable would not be flagged
  // a dynamic boundary and the closure would falsely read `complete` (§3.3).
  const callableByKind =
    CALLABLE_KINDS.has(view.definition?.kind ?? '') || view.definition?.callable === true;
  return {
    ok: true,
    enclosers,
    groupTotal: (view.groupTotal ?? all.length) - droppedDecl,
    callableNatured: callableByKind || enclosers.some((g) => rolesIncludeCallable(g.roles)),
  };
}
