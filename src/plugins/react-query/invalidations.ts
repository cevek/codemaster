// `invalidations_for` policy: resolve a mutation ref (its enclosing-declaration name, or a
// callId/SymbolId) to the matched mutation site(s), then resolve each invalidation edge to the
// queries it affects by prefix-matching keys (query-key.ts). Per-hop confidence is the match's:
// a proven static prefix is `certain`; a dynamic segment or a broad invalidation is honest
// uncertainty (`partial`/`dynamic`), never asserted certain (§3.3).

import { matchKey } from './query-key.ts';
import type { RqState } from './registries.ts';
import type {
  AffectedQuery,
  InvalidationEdge,
  InvalidationsForView,
  QueryEntry,
  ResolvedInvalidation,
  ResolvedMutation,
} from './views.ts';

export function computeInvalidationsFor(state: RqState, ref: string): InvalidationsForView {
  const matched = state.mutations.filter((m) => m.name === ref || m.callId === ref || m.id === ref);
  const mutations: ResolvedMutation[] = matched.map((m) => ({
    id: m.id,
    name: m.name,
    site: m.site,
    edges: m.invalidates.map((edge) => resolveEdge(edge, state.queries)),
  }));
  const dynamicKeyedQueries = state.queries.filter((q) => q.queryKey.opaque !== undefined).length;
  return { query: ref, mutations, dynamicKeyedQueries, moduleResolved: state.moduleResolved };
}

function resolveEdge(edge: InvalidationEdge, queries: readonly QueryEntry[]): ResolvedInvalidation {
  const affects: AffectedQuery[] = [];
  for (const q of queries) {
    const confidence = matchKey(edge.key, edge.all, q.queryKey, {
      exact: edge.exact,
      narrowed: edge.narrowed,
    });
    if (confidence === undefined) continue;
    affects.push({ id: q.id, name: q.name, queryKey: q.queryKey, site: q.site, confidence });
  }
  return {
    method: edge.method,
    ...(edge.key !== undefined ? { key: edge.key } : {}),
    all: edge.all,
    exact: edge.exact,
    narrowed: edge.narrowed,
    span: edge.span,
    affects,
  };
}
