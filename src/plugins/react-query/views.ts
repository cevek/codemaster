// Output shapes for the `react-query` plugin (§5-L2). Proof-carrying (every fact a `Span`) and
// honesty-explicit (`Confidence` per key / per relation hop). Domain types live here so the
// factory (plugin.ts) and the extraction (registries.ts / invalidations.ts) stay under the line
// cap. NOTHING here parses — these describe facts derived from the ts plugin's `callArgShapes`.
//
// `type` aliases (not `interface`): these flow into an op's `Result<JsonValue>` data, and an
// interface is NOT assignable to JsonValue's index signature (it can be augmented) — a type alias
// of an object literal is. Keep them aliases or the op stops typechecking.

import type { Confidence, Span } from '../../core/span.ts';

/** A non-static queryKey segment's syntactic shape — mirrors the ts seam's dynamic `ValueShape`
 *  kinds. A segment is `dynamic` (its value is not statically determinable, §3.3) when it is any
 *  of these; we flag it, never guess its runtime value. */
type DynamicShape =
  | 'identifier'
  | 'property-access'
  | 'template'
  | 'spread'
  | 'call'
  | 'array'
  | 'object'
  | 'function'
  | 'other';

/** One element of a queryKey array. A string/number/bool/null literal is `static` (read
 *  verbatim — `certain`); anything else is `dynamic` with its shape flagged. */
export type QueryKeySegment =
  | { kind: 'static'; value: string; span: Span }
  | { kind: 'dynamic'; shape: DynamicShape; span: Span };

/** A classified queryKey. `segments` carries the per-element classification when the key is an
 *  array literal; `opaque` is set instead when the key value is NOT an array (a bare identifier /
 *  call / template) — the whole key is then indeterminate. `confidence`: `certain` = array with
 *  every segment static; `partial` = array with ≥1 dynamic segment; `dynamic` = opaque key. */
export type QueryKeyView = {
  segments: QueryKeySegment[];
  opaque?: DynamicShape;
  confidence: Confidence;
  span: Span;
};

/** A query registry entry — a `useQuery` / `useInfiniteQuery` call. `id` is the chainable
 *  SymbolId of the enclosing declaration (→ find_usages / rename). */
export type QueryEntry = {
  id: string;
  name: string;
  kind: 'query' | 'infinite';
  callId: string;
  site: Span;
  queryKey: QueryKeyView;
};

/** A cache-affecting call inside a mutation (or standalone): `invalidateQueries` /
 *  `refetchQueries` / `removeQueries`. `all` = called with no filter (affects every query).
 *  `exact` = an `exact:true` filter (match only the same-length key, not a prefix). `narrowed` =
 *  the filter carries a prop we cannot evaluate (`predicate`/`type`/a dynamic `exact`) that shrinks
 *  the match set, so a prefix match is only an UPPER BOUND → matches demote to `partial` (§3.3). */
export type InvalidationEdge = {
  method: 'invalidate' | 'refetch' | 'remove';
  /** Absent when the call is broad (`all`) — invalidate everything, no specific key. */
  key?: QueryKeyView;
  all: boolean;
  exact: boolean;
  narrowed: boolean;
  span: Span;
};

/** A mutation registry entry — a `useMutation` call, with the invalidations its callbacks fire. */
export type MutationEntry = {
  id: string;
  name: string;
  callId: string;
  site: Span;
  invalidates: InvalidationEdge[];
};

export type MutationsView = {
  mutations: MutationEntry[];
  moduleResolved: boolean;
};

export type QueriesView = {
  queries: QueryEntry[];
  moduleResolved: boolean;
};

/** A query a mutation's invalidation provably (or possibly) affects, with the per-hop confidence
 *  of THAT match (certain = static prefix proven; partial = a dynamic segment on either side;
 *  dynamic = a broad/opaque invalidation that hits everything). */
export type AffectedQuery = {
  id: string;
  name: string;
  queryKey: QueryKeyView;
  site: Span;
  confidence: Confidence;
};

export type ResolvedInvalidation = {
  method: 'invalidate' | 'refetch' | 'remove';
  key?: QueryKeyView;
  all: boolean;
  /** `exact:true` filter — only a same-length key matches, not a prefix. */
  exact: boolean;
  /** The filter narrows in a way we cannot evaluate (`predicate`/`type`/dynamic `exact`) — every
   *  match here is an upper bound, capped at `partial` (a runtime predicate may exclude it). */
  narrowed: boolean;
  /** The EDGE's own confidence (distinct from a per-`affects` match): a broad `invalidateQueries()`
   *  with no key, or an opaque key, is `dynamic`; otherwise the key's own confidence. Lifted onto
   *  the view so `invalidations_for` and `trace_invalidation` read ONE source and cannot drift. */
  confidence: Confidence;
  span: Span;
  affects: AffectedQuery[];
};

export type ResolvedMutation = {
  id: string;
  name: string;
  site: Span;
  edges: ResolvedInvalidation[];
};

/** `invalidations_for` output: the matched mutation site(s) for the asked ref (0 = not found),
 *  each with its invalidation edges resolved to the queries they affect. */
export type InvalidationsForView = {
  query: string;
  mutations: ResolvedMutation[];
  /** Queries whose key is opaque (computed) — they cannot be matched against a CONCRETE
   *  invalidation prefix either way, so they are excluded from `affects` and counted here instead
   *  (§3.4: the affect-set is never dressed as complete when dynamic keys exist). */
  dynamicKeyedQueries: number;
  moduleResolved: boolean;
};
