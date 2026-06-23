// The trace-hop contract — the domain-neutral foundation every `trace_*` op emits (Phase 6, §3.3).
// A trace is a flat list of HOPS, each connecting two NODES. The flat list reconstructs into a
// tree / DAG by node IDENTITY (`key`), so the contract's load-bearing rule is the key, not the
// hop order. Each hop is independently PROOF-CARRYING (it embeds its full from/to nodes and its own
// per-hop confidence + provenance) — denormalized on purpose, so a hop never depends on a sibling
// to be trustworthy. `kind` / `relation` are OPEN strings: each trace picks its own domain labels
// (invalidation: mutation/queryKey/query/component + invalidates/affects/used-by/mounted-at); the
// renderer dispatches on the single `~shape` tag, never on these labels.
//
// `type` aliases (not `interface`): these flow into an op's `Result<JsonValue>` data, and an
// interface is not assignable to JsonValue's index signature — keep them aliases or ops stop
// typechecking (the react-query views.ts precedent).

import type { Confidence, Provenance, Span } from '../../core/span.ts';

/** One end of a hop. `key` is the IDENTITY used to dedup nodes and reconstruct the graph: the
 *  chainable `SymbolId` when the node is addressable (→ chains into other ops), else a stable
 *  `kind@file:line:col` derived from its proof span. `id` is the SymbolId only when present
 *  (a queryKey node has none). `label` is the agent-facing name (`useTodos`, `['todos']`). */
export type TraceNode = {
  kind: string;
  label: string;
  key: string;
  id?: string;
  span: Span;
};

/** A single proven (or honestly-uncertain) link. `confidence` + `provenance` are PER-HOP (§3.3):
 *  a dynamic/partial hop is flagged at the step it occurs, never silently bridged. `note` carries
 *  the WHY when not `certain` (a broad invalidate, a dynamic key segment, a depth-cap, an opaque
 *  mount ref). */
export type TraceHop = {
  from: TraceNode;
  to: TraceNode;
  relation: string;
  confidence: Confidence;
  provenance: Provenance;
  note?: string;
};

/** Derive a node's identity key: the SymbolId when addressable, else span-anchored. The
 *  span-anchored form is stable across a call (same declaration → same loc), so two hops touching
 *  the same unaddressable node (e.g. a queryKey) dedup correctly. */
export function nodeKey(kind: string, span: Span, id?: string): string {
  return id ?? `${kind}@${span.file}:${span.line}:${span.col}`;
}

/** Build a node, computing its `key` from `id`/`span` (the one place the identity rule lives). */
export function makeNode(args: {
  kind: string;
  label: string;
  span: Span;
  id?: string;
}): TraceNode {
  const key = nodeKey(args.kind, args.span, args.id);
  return {
    kind: args.kind,
    label: args.label,
    key,
    ...(args.id !== undefined ? { id: args.id } : {}),
    span: args.span,
  };
}

/** Build a hop. `note` is attached only when present, so a clean hop carries no empty field. */
export function makeHop(args: {
  from: TraceNode;
  to: TraceNode;
  relation: string;
  confidence: Confidence;
  provenance: Provenance;
  note?: string;
}): TraceHop {
  return {
    from: args.from,
    to: args.to,
    relation: args.relation,
    confidence: args.confidence,
    provenance: args.provenance,
    ...(args.note !== undefined ? { note: args.note } : {}),
  };
}

/** Distinct hops, deduped by `(from.key, relation, to.key)` (first wins). A DAG reached by a
 *  diamond (two invalidation reasons converging on one query) emits the shared downstream edge
 *  more than once; this collapses those identical edges so the trace shows each fact once. */
export function dedupHops(hops: readonly TraceHop[]): TraceHop[] {
  const seen = new Set<string>();
  const out: TraceHop[] = [];
  for (const h of hops) {
    const id = `${h.from.key}|${h.relation}|${h.to.key}`;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(h);
  }
  return out;
}
