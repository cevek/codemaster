// Extraction (§5-L2): turn the ts seam's generic `callArgShapes` rows into react-query's mutation
// and query registries. Pure over the scan result — NO ts/AST access here (the seam already did
// the parsing, §4). queryKey/mutationKey come from the matched call's first-arg object shape;
// an invalidation call (`invalidateQueries`/`refetch`/`remove`) is tied to its enclosing mutation
// via the seam's `enclosingCallId` (the precise disambiguator when one hook holds >1 mutation).
// A v5 invalidation filter's `exact`/`predicate`/`type` props are honoured (exact = same-length
// match; an unevaluable narrowing prop caps a match at `partial`, never a false `certain`).

import type { Span } from '../../core/span.ts';
import { classifyQueryKey } from './query-key.ts';
import type { ShapedCall, ValueShape, ValueProp } from './seam-types.ts';
import type { InvalidationEdge, MutationEntry, QueryEntry, QueryKeyView } from './views.ts';

export interface RqState {
  mutations: MutationEntry[];
  queries: QueryEntry[];
  moduleResolved: boolean;
}

const QUERY_KIND: Record<string, QueryEntry['kind'] | undefined> = {
  useQuery: 'query',
  useInfiniteQuery: 'infinite',
};
const INVALIDATE_METHOD: Record<string, InvalidationEdge['method'] | undefined> = {
  invalidateQueries: 'invalidate',
  refetchQueries: 'refetch',
  removeQueries: 'remove',
};

export function buildRegistries(scan: {
  calls: readonly ShapedCall[];
  moduleResolved: boolean;
}): RqState {
  const byId = new Map<string, ShapedCall>();
  for (const call of scan.calls) byId.set(call.callId, call);

  // Pass 1 — queries + mutation shells (so an invalidation can find its enclosing mutation).
  const queries: QueryEntry[] = [];
  const mutationById = new Map<string, MutationEntry>();
  for (const call of scan.calls) {
    const qk = QUERY_KIND[call.fn];
    if (qk !== undefined) {
      queries.push({
        id: call.encloser.id,
        name: call.encloser.name,
        kind: qk,
        callId: call.callId,
        site: call.callSpan,
        queryKey: keyFromArg(call.args[0], 'queryKey', call.callSpan),
      });
    } else if (call.fn === 'useMutation') {
      mutationById.set(call.callId, {
        id: call.encloser.id,
        name: call.encloser.name,
        callId: call.callId,
        site: call.callSpan,
        invalidates: [],
      });
    }
  }

  // Pass 2 — invalidations, attached to their enclosing mutation when there is one.
  for (const call of scan.calls) {
    const method = INVALIDATE_METHOD[call.fn];
    if (method === undefined) continue;
    const ownerId = enclosingMutationId(call, byId, mutationById);
    if (ownerId === undefined) continue; // a direct cache op outside a mutation — not a relation
    mutationById.get(ownerId)?.invalidates.push(invalidationEdge(method, call));
  }

  return { mutations: [...mutationById.values()], queries, moduleResolved: scan.moduleResolved };
}

/** Walk the enclosing-matched-call chain until a `useMutation` site is reached. */
function enclosingMutationId(
  call: ShapedCall,
  byId: ReadonlyMap<string, ShapedCall>,
  mutations: ReadonlyMap<string, MutationEntry>,
): string | undefined {
  const seen = new Set<string>();
  let cur = call.enclosingCallId;
  while (cur !== undefined && !seen.has(cur)) {
    seen.add(cur);
    if (mutations.has(cur)) return cur;
    cur = byId.get(cur)?.enclosingCallId;
  }
  return undefined;
}

function invalidationEdge(method: InvalidationEdge['method'], call: ShapedCall): InvalidationEdge {
  const arg = call.args[0];
  // No arg → invalidate everything. A v4 positional array arg IS the key. A v5 object filter
  // carries `queryKey` (+ optional narrowing props handled below).
  if (arg === undefined)
    return { method, all: true, exact: false, narrowed: false, span: call.callSpan };
  if (arg.kind === 'array') {
    return {
      method,
      key: classifyQueryKey(arg),
      all: false,
      exact: false,
      narrowed: false,
      span: arg.span,
    };
  }
  if (arg.kind === 'object') {
    const qk = getProp(arg.props, 'queryKey');
    const exactProp = getProp(arg.props, 'exact');
    const exactIsLiteralBool = exactProp?.kind === 'boolean';
    const exact = exactProp?.kind === 'boolean' && exactProp.value === 'true';
    // Any filter prop beyond `queryKey` (and a literal-bool `exact`, which we model precisely)
    // narrows the set in a way we cannot evaluate (predicate/type/dynamic exact) → upper bound.
    const narrowed = arg.props.some(
      (p) => p.key !== 'queryKey' && !(p.key === 'exact' && exactIsLiteralBool),
    );
    if (qk === undefined) return { method, all: true, exact: false, narrowed, span: arg.span };
    return { method, key: classifyQueryKey(qk), all: false, exact, narrowed, span: qk.span };
  }
  // A filter passed as a variable / spread — opaque, treated as broad.
  return {
    method,
    key: classifyQueryKey(arg),
    all: false,
    exact: false,
    narrowed: false,
    span: arg.span,
  };
}

function keyFromArg(arg: ValueShape | undefined, prop: string, fallback: Span): QueryKeyView {
  const value = arg !== undefined && arg.kind === 'object' ? getProp(arg.props, prop) : undefined;
  if (value === undefined) {
    // The required key is absent / not statically locatable — unresolved, never a fabricated key.
    return { segments: [], opaque: 'other', confidence: 'unresolved', span: arg?.span ?? fallback };
  }
  return classifyQueryKey(value);
}

function getProp(props: readonly ValueProp[], key: string): ValueShape | undefined {
  return props.find((p) => p.key === key)?.value;
}
