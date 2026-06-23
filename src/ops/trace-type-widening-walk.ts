// The `trace_type_widening` traversal — the recipe that drives the bounded forward walk over the
// `ts` plugin's `wideningSinksAt` primitive into a flat list of proof-carrying trace-hops (§3.3,
// §17 Phase 6). The plugin owns the single AST/checker step (the value's type, its immediate
// flow-sinks, the widening verdict); THIS owns the recursion and the per-hop honesty:
//
//   value --assigned-to/passed-to/returned-as/reassigned-to--> sink (its possibly-wider type)
//     a widened hop carries its WIDENS(kind); a boundary (any/unknown/untyped) is `dynamic` + a leaf
//
// Bounded like trace_invalidation: a global visited-set (cycle / diamond), a depth cap, and a node
// cap — every truncation surfaced (note + `truncated`), never a silent stop or an infinite walk (§1).

import {
  dedupHops,
  makeHop,
  makeNode,
  type TraceHop,
  type TraceNode,
} from '../common/trace/hop.ts';
import type { Provenance } from '../core/span.ts';
import type {
  TsPluginApi,
  TsTargetInput,
  WideningEndpoint,
  WideningSink,
} from '../plugins/ts/plugin.ts';

const TYPE_PROV: Provenance = { kind: 'type' }; // every widening verdict is checker-derived
const DEPTH_CAP = 16; // forward-chain backstop (paired with the visited set)
const NODE_CAP = 200; // total values expanded — the never-hang ceiling

export type WideningTraceResult = {
  hops: TraceHop[];
  /** Hops where precision was lost — the headline verdict. */
  widenings: number;
  notes: string[];
  truncated: boolean;
};

/** `{ error }` only when the START target itself does not resolve to a value (a bad handle / name) —
 *  the op turns that into an honest ToolFailure. A deeper unresolved boundary is a NOTE, not an
 *  error (the trace is still a real partial answer). */
export function walkTypeWidening(
  ts: TsPluginApi,
  start: TsTargetInput,
): WideningTraceResult | { error: string } {
  const seed = ts.wideningSinksAt(start);
  if (typeof seed === 'string') return { error: seed };
  if ('unresolved' in seed) return { error: seed.unresolved };

  const hops: TraceHop[] = [];
  const notes: string[] = [];
  const visited = new Set<string>();
  let widenings = 0;
  let truncated = false;
  let nodeCount = 0;

  // Expand one already-fetched value view: emit a hop per sink, recurse into each sink's `next`.
  const expandView = (
    view: {
      node: WideningEndpoint;
      sinks: readonly WideningSink[];
      truncated?: { shown: number; total: number };
    },
    depth: number,
  ): void => {
    const fromNode = makeNode({
      kind: 'value',
      label: endpointLabel(view.node),
      span: view.node.span,
    });
    if (visited.has(fromNode.key)) return; // diamond / cycle — the back-edge hops below still ran once
    visited.add(fromNode.key);
    nodeCount++;
    if (view.truncated !== undefined) {
      truncated = true;
      notes.push(
        `${view.node.label}: forward references capped (${view.truncated.shown}/${view.truncated.total}) — more sinks may exist`,
      );
    }
    for (const sink of view.sinks) {
      const toNode = makeNode({ kind: 'value', label: endpointLabel(sink.to), span: sink.to.span });
      pushHop(fromNode, toNode, sink);
      if (sink.widened) widenings++;
      if (sink.next !== undefined && !visited.has(toNode.key)) expandTarget(sink.next, depth + 1);
    }
  };

  // Fetch + expand the value at a `next` position; a non-root resolution failure is a note.
  const expandTarget = (target: TsTargetInput, depth: number): void => {
    if (nodeCount >= NODE_CAP) {
      truncated = true;
      notes.push(`node cap (${NODE_CAP}) reached — the trace is incomplete`);
      return;
    }
    if (depth > DEPTH_CAP) {
      truncated = true;
      notes.push(`depth cap (${DEPTH_CAP}) reached — deeper flow not traced`);
      return;
    }
    const out = ts.wideningSinksAt(target);
    if (typeof out === 'string') {
      notes.push(out);
      return;
    }
    if ('unresolved' in out) {
      notes.push(out.unresolved);
      return;
    }
    expandView(out.view, depth);
  };

  const pushHop = (from: TraceNode, to: TraceNode, sink: WideningSink): void => {
    const note = sinkNote(sink);
    hops.push(
      makeHop({
        from,
        to,
        relation: sink.relation,
        confidence: sink.confidence,
        provenance: TYPE_PROV,
        ...(note !== undefined ? { note } : {}),
      }),
    );
  };

  expandView(seed.view, 0);
  return { hops: dedupHops(hops), widenings, notes, truncated };
}

/** A value node's label carries its TYPE — `c: 'red'`, `x: string` — so the trace reads as the
 *  precision changing along the chain (the type can't live on the domain-neutral TraceNode). */
function endpointLabel(e: WideningEndpoint): string {
  return `${e.label}: ${e.typeText}`;
}

/** The why behind a hop: the widening kind (load-bearing) for a widened hop, the boundary note for a
 *  dynamic one, or `preserved` when precision held. */
function sinkNote(sink: WideningSink): string | undefined {
  if (sink.widened) {
    return `WIDENS (${sink.kind ?? 'wider'})${sink.note !== undefined ? ` — ${sink.note}` : ''}`;
  }
  return sink.note ?? 'preserved';
}
