// `list` registry exposure (§11 / core/list.ts): react-query contributes three registries —
// `mutations`, `queries`, `queryKeys` — to the generic `list` op via the optional Plugin members.
// Proof-carrying: each entry ships its declaration span + an explicit confidence. Detection is a
// framework-convention identification, so provenance is `heuristic:react-query` (never dressed as
// a structural fact, §3.3); a composite queryKey is reported per-segment with dynamic flags, never
// flattened/guessed.

import type { Provenance } from '../../core/span.ts';
import type { KeySegment, ListEntry, ListView } from '../../core/list.ts';
import type { RqState } from './registries.ts';
import type { QueryKeyView } from './views.ts';

export const REGISTRIES = ['mutations', 'queries', 'queryKeys'] as const;

const PROVENANCE: Provenance = { kind: 'heuristic', by: 'react-query' };

/** A queryKey as core/list `KeySegment[]`: a static segment carries its literal `value`; a dynamic
 *  segment (or a wholly opaque key) is `{ dynamic: true }` — flagged, never guessed (§3.3). */
function keySegments(key: QueryKeyView): KeySegment[] {
  if (key.opaque !== undefined) return [{ dynamic: true }];
  return key.segments.map((s) =>
    s.kind === 'static' ? { value: s.value, dynamic: false } : { dynamic: true },
  );
}

export function buildListView(state: RqState, registry: string): ListView | undefined {
  const note = state.moduleResolved
    ? undefined
    : "'@tanstack/react-query' did not resolve — this registry is not authoritative";
  const wrap = (entries: ListEntry[]): ListView => ({
    registry,
    entries,
    ...(note !== undefined ? { note } : {}),
  });

  if (registry === 'mutations') {
    return wrap(
      state.mutations.map((m) => ({
        name: m.name,
        kind: 'mutation',
        span: m.site,
        confidence: 'certain',
        provenance: PROVENANCE,
        ...(m.invalidates.length > 0
          ? { detail: `invalidates ${m.invalidates.length} key(s)` }
          : {}),
      })),
    );
  }
  if (registry === 'queries') {
    return wrap(
      state.queries.map((q) => ({
        name: q.name,
        kind: q.kind === 'infinite' ? 'infinite-query' : 'query',
        span: q.site,
        confidence: 'certain',
        provenance: PROVENANCE,
      })),
    );
  }
  if (registry === 'queryKeys') {
    return wrap(
      state.queries.map((q) => ({
        segments: keySegments(q.queryKey),
        kind: 'queryKey',
        span: q.queryKey.span,
        confidence: q.queryKey.confidence,
        provenance: PROVENANCE,
      })),
    );
  }
  return undefined;
}
