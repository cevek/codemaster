// queryKey policy (§3.3 honesty boundary) — the react-query-OWNED interpretation of the ts seam's
// generic `ValueShape`. An inline array of literals is a `certain` key; a dynamic segment
// (identifier / member / template / spread / call) is flagged and demotes the key to `partial`; a
// non-array key value (a bare identifier / factory call) is `dynamic` (opaque) — never guessed.
//
// The seam classifies SYNTAX; the queryKey/prefix SEMANTICS (react-query invalidation is a
// prefix filter: a query is hit iff its key STARTS WITH the invalidation key) live here.

import type { Confidence } from '../../core/span.ts';
import type { ValueShape } from './seam-types.ts';
import type { QueryKeySegment, QueryKeyView } from './views.ts';

/** Classify one queryKey value. An array → per-element segments; a lone literal → a one-segment
 *  certain key; anything else → an opaque `dynamic` key. */
export function classifyQueryKey(value: ValueShape): QueryKeyView {
  if (value.kind === 'array') {
    const segments = value.elements.map(toSegment);
    const confidence: Confidence = segments.some((s) => s.kind === 'dynamic')
      ? 'partial'
      : 'certain';
    return { segments, confidence, span: value.span };
  }
  const seg = toSegment(value);
  if (seg.kind === 'static') return { segments: [seg], confidence: 'certain', span: value.span };
  return { segments: [], opaque: seg.shape, confidence: 'dynamic', span: value.span };
}

function toSegment(v: ValueShape): QueryKeySegment {
  if (v.kind === 'string' || v.kind === 'number' || v.kind === 'boolean') {
    return { kind: 'static', value: v.value, span: v.span };
  }
  if (v.kind === 'null') return { kind: 'static', value: 'null', span: v.span };
  // Every remaining ValueShape kind is statically indeterminate (§3.3); `v.kind` is exactly the
  // dynamic subset, which IS `DynamicShape`.
  return { kind: 'dynamic', shape: v.kind, span: v.span };
}

/** Does an invalidation key hit a query key? react-query invalidation is a PREFIX filter: a query
 *  matches iff its key starts with the invalidation key. Returns the match confidence, or
 *  `undefined` when the prefix does not (provably) match.
 *  - a broad invalidation (no key / opaque / empty prefix) hits every query → `dynamic`
 *  - a fully-static prefix proven against a static query prefix → `certain`
 *  - any dynamic segment compared (either side) → `partial` (possible, not proven)
 *  - a CONCRETE prefix against an OPAQUE query key → `undefined`: not provable either way. Such
 *    queries are not silently dropped — the caller reports their count (§3.4), so the answer is
 *    never dressed as a complete affect-set.
 *  - `exact`: the filter matches only a SAME-LENGTH key (not a prefix), so a longer query key is
 *    no match — without this an `exact:true` invalidation would over-claim a longer-keyed query.
 *  - `narrowed`: an unevaluable filter prop (`predicate`/`type`/dynamic `exact`) shrinks the set,
 *    so a prefix match is an upper bound → capped at `partial`, never `certain` (§3.3). */
export function matchKey(
  invKey: QueryKeyView | undefined,
  all: boolean,
  queryKey: QueryKeyView,
  opts: { exact?: boolean; narrowed?: boolean } = {},
): Confidence | undefined {
  const cap = (c: Confidence): Confidence =>
    opts.narrowed === true && c === 'certain' ? 'partial' : c;
  if (all || invKey === undefined || invKey.opaque !== undefined || invKey.segments.length === 0) {
    return cap('dynamic');
  }
  if (queryKey.opaque !== undefined) return undefined;
  // `exact` requires equal length; otherwise a query key shorter than the filter prefix cannot
  // start with it (spread/length unknowns are `dynamic` segments handled below; literal length is
  // the v1 bound).
  if (opts.exact === true && queryKey.segments.length !== invKey.segments.length) return undefined;
  if (queryKey.segments.length < invKey.segments.length) return undefined;

  let sawDynamic = false;
  for (let i = 0; i < invKey.segments.length; i++) {
    const inv = invKey.segments[i];
    const q = queryKey.segments[i];
    if (inv === undefined || q === undefined) return undefined;
    if (inv.kind === 'static' && q.kind === 'static') {
      if (inv.value !== q.value) return undefined; // provably distinct prefix
    } else {
      sawDynamic = true; // one side indeterminate — possible match, not proven
    }
  }
  return cap(sawDynamic ? 'partial' : 'certain');
}
