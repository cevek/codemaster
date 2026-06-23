// The trace_invalidation traversal — the recipe that walks one resolved invalidation view into a
// flat list of proof-carrying trace-hops (§3.3, §17 build order, Phase 6). It composes three plugin
// surfaces and OWNS the per-hop honesty: every hop is flagged at the step its uncertainty arises
// (a broad invalidate, a dynamic key, an opaque mount ref, a depth-cap / cycle), never silently
// bridged. The chain:
//
//   mutation --invalidates--> queryKey --affects--> useQuery --in--> host
//     host is a component  → re-renders; --mounted-at--> each <Host/> site (a LOCATION leaf)
//     host is a hook       → --used-by--> each consumer; recurse (the consumer re-renders / is mounted)
//
// THE #1 TRUST POINT: invalidation re-renders the SUBSCRIBER (the useQuery host, or the component
// consuming the hook), NOT the parent that places `<Host/>`. So `mounted-at` targets are
// LOCATION leaves (kind 'mount'), never counted as re-rendering; `reRenderComponents` counts only
// the component HOSTS/consumers reached along the chain (the op states this in its notes).

import type { Confidence, Provenance, Span } from '../core/span.ts';
import {
  dedupHops,
  makeHop,
  makeNode,
  type TraceHop,
  type TraceNode,
} from '../common/trace/hop.ts';
import { summarizeQueryKey } from '../format/render/shapes/helpers.ts';
import type { ReactPluginApi } from '../plugins/react/plugin.ts';
import type { TsPluginApi, TsTargetInput } from '../plugins/ts/plugin.ts';
import type { InvalidationsForView, ResolvedInvalidation } from '../plugins/react-query/views.ts';

const RQ_PROV: Provenance = { kind: 'heuristic', by: 'react-query' };
const TYPE_PROV: Provenance = { kind: 'type' }; // find_usages — LS-semantic
const SYN_PROV: Provenance = { kind: 'syntactic' }; // enclosing / jsxCallSites — syntactic
const DEPTH_CAP = 12; // hook→hook recursion backstop (never-hang, §1) — paired with the visited set
const USAGE_LIMIT = 50;

export type TraceResult = {
  hops: TraceHop[];
  /** Distinct re-rendering component HOSTS (NOT mount locations) — the headline verdict. */
  reRenderComponents: number;
  notes: string[];
  truncated: boolean;
};

/** A `file:line:col` target — the robust address for chaining ts seams (the unused-props
 *  precedent): we resolve THROUGH the LS, never compare SymbolId strings minted by different paths. */
function locTarget(span: Span): TsTargetInput {
  return { file: span.file, line: span.line, col: span.col };
}

export function walkInvalidationTrace(
  view: InvalidationsForView,
  ts: TsPluginApi,
  react: ReactPluginApi,
): TraceResult {
  const hops: TraceHop[] = [];
  const notes: string[] = [];
  const reRender = new Set<string>();
  // Global visited-before-recurse: a decl whose OUTGOING subtree is already emitted is never
  // re-walked — bounds the work, and breaks a hook→hook cycle cleanly (the back-edge hop is still
  // emitted, then expansion stops; no infinite loop, no misleading note). The depth counter is a
  // backstop for a pathologically deep acyclic chain.
  const visited = new Set<string>();
  let truncated = false;

  const push = (
    from: TraceNode,
    to: TraceNode,
    relation: string,
    confidence: Confidence,
    provenance: Provenance,
    note?: string,
  ): void => {
    hops.push(makeHop({ from, to, relation, confidence, provenance, ...(note ? { note } : {}) }));
  };

  // Emit each `<Host/>` mount as a LOCATION leaf; an opaque ref (alias/factory/spread) is a dynamic
  // mount, flagged not dropped; 0 sites is an honest note (root/route element), never a guessed hop.
  const mount = (host: TraceNode, span: Span): void => {
    const out = ts.jsxCallSites(locTarget(span));
    if (typeof out === 'string' || !('view' in out)) {
      notes.push(
        `${host.label}: could not read mount sites (${typeof out === 'string' ? out : out.unresolved})`,
      );
      return;
    }
    const v = out.view;
    for (const site of v.sites) {
      const m = makeNode({ kind: 'mount', label: `<${host.label}/>`, span: site.span });
      push(host, m, 'mounted-at', 'certain', SYN_PROV);
    }
    for (const ref of v.opaqueRefs) {
      const m = makeNode({ kind: 'mount', label: `<${host.label}/>`, span: ref.span });
      push(
        host,
        m,
        'mounted-at',
        'dynamic',
        SYN_PROV,
        `opaque ${ref.role} reference — not statically a <Host/> mount`,
      );
    }
    if (v.truncated !== undefined) {
      truncated = true;
      notes.push(
        `${host.label}: mount sites capped (${v.truncated.shown}/${v.truncated.total}) — more exist`,
      );
    }
    if (v.sites.length === 0 && v.opaqueRefs.length === 0) {
      notes.push(
        `${host.label}: no static mount site (a root / route element / ReactDOM.render target)`,
      );
    }
  };

  // Expand a subscriber declaration: a component re-renders + mounts; a hook fans out to its
  // consumers. The parent→node hop is ALWAYS emitted (the edge is real); the node's OUTGOING
  // subtree is walked at most once (the visited guard), so a diamond / cycle never re-walks or
  // loops. `depth` is the acyclic-chain backstop.
  const expand = (
    target: TsTargetInput,
    from: TraceNode,
    relation: string,
    prov: Provenance,
    depth: number,
  ): void => {
    const cls = react.classify(target);
    if (typeof cls === 'string') {
      notes.push(`subscriber not classified: ${cls}`);
      return;
    }
    const node = makeNode({
      kind: cls.kind,
      label: cls.name,
      span: cls.span,
      ...(target.symbolId !== undefined ? { id: target.symbolId } : {}),
    });
    const conf: Confidence = cls.kind === 'component' ? cls.confidence : 'certain';
    const note =
      cls.kind === 'component' && conf !== 'certain'
        ? 'wrapped/indirect component — JSX inferred, not directly returned'
        : undefined;
    push(from, node, relation, conf, prov, note);

    if (cls.kind === 'component') reRender.add(node.key);
    if (visited.has(node.key)) return; // subtree already emitted (diamond / cycle) — silent
    visited.add(node.key);

    if (cls.kind === 'component') {
      mount(node, cls.span);
      return;
    }
    if (cls.kind === 'hook') {
      if (depth >= DEPTH_CAP) {
        truncated = true;
        notes.push(
          `${cls.name}: hook-chain depth cap (${DEPTH_CAP}) — deeper consumers not expanded`,
        );
        return;
      }
      const usages = ts.findUsages(locTarget(cls.span), {
        limit: USAGE_LIMIT,
        groupBy: 'enclosing',
        collapseImports: true,
      });
      if (typeof usages === 'string' || !('view' in usages)) {
        notes.push(`${cls.name}: could not read consumers`);
        return;
      }
      const rawGroups = usages.view.groups ?? [];
      const groupTotal = usages.view.groupTotal ?? rawGroups.length;
      if (groupTotal > rawGroups.length) {
        truncated = true;
        notes.push(
          `${cls.name}: ${groupTotal} enclosers, ${rawGroups.length} shown — more consumers may exist`,
        );
      }
      // find_usages includes the declaration's own definition site, which rolls up to the hook
      // ITSELF — drop that self-group (a hook is not its own consumer), matched by name-token loc.
      const groups = rawGroups.filter(
        (g) => !(g.file === cls.span.file && g.line === cls.span.line && g.col === cls.span.col),
      );
      if (groups.length === 0) notes.push(`${cls.name}: no consumers found`);
      for (const g of groups) expand({ symbolId: g.id }, node, 'used-by', TYPE_PROV, depth + 1);
      return;
    }
    // 'other' — resolved to a declaration that is neither component nor hook.
    notes.push(`${cls.name}: not a component or hook — re-render target undetermined here`);
  };

  for (const m of view.mutations) {
    const mutationNode = makeNode({ kind: 'mutation', label: m.name, span: m.site, id: m.id });
    for (const e of m.edges) {
      const keyNode = makeNode({
        kind: 'queryKey',
        label: e.all ? '(all)' : summarizeQueryKey(e.key),
        span: e.key?.span ?? e.span,
      });
      push(mutationNode, keyNode, 'invalidates', e.confidence, RQ_PROV, edgeNote(e));
      for (const a of e.affects) {
        const queryNode = makeNode({ kind: 'query', label: `useQuery(${a.name})`, span: a.site });
        push(keyNode, queryNode, 'affects', a.confidence, RQ_PROV);
        expand({ symbolId: a.id }, queryNode, 'in', SYN_PROV, 0);
      }
    }
  }

  return { hops: dedupHops(hops), reRenderComponents: reRender.size, notes, truncated };
}

/** The why behind a non-certain invalidate hop — surfaced on the hop, never silent. */
function edgeNote(e: ResolvedInvalidation): string | undefined {
  if (e.all) return 'broad invalidateQueries() with no key — affects every query';
  if (e.confidence === 'partial') return 'dynamic key segment — affected set is an upper bound';
  if (e.confidence === 'dynamic') return 'opaque (computed) key — cannot be matched statically';
  return undefined;
}
