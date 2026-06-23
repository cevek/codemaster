// The trace_prop_through_tree traversal — walks a prop DOWN a component tree into a flat list of
// proof-carrying hops (§3.3, §17 Phase 6). It composes two seams — `ts.jsxChildSites` (the JSX a
// body renders + per-attr value signal) and `react.classify` (is a tag a component) — and OWNS the
// per-hop honesty: a forward is flagged at the step its uncertainty arises, never silently bridged.
//
//   component --passes/renames/spreads/derives--> child  (recurse if the prop's IDENTITY survives)
//     child is a component → keep walking with the prop name it now carries
//     child is a host element / non-component → a flow SINK leaf (the prop reaches the DOM here)
//
// HONESTY: every forward is SYNTACTIC (an identifier match, not type-resolved), so an as-is forward
// is `partial` (a same-named local could shadow); a RENAME, a `{...spread}` (child prop name
// unknown), and a DERIVED expression (`{userId.id}`, value transformed) are each `dynamic` — flagged
// on the hop, with the spread/derived/rename reason in `note`. Bounded (§19): DEPTH_CAP + a
// (component|prop) visited-set (a recursive / diamond tree never re-walks or loops) + a NODE_CAP on
// total hops → `truncated:true` + a note, never a spin or a silent partial.

import type { Confidence, Provenance, Span } from '../core/span.ts';
import {
  dedupHops,
  makeHop,
  makeNode,
  type TraceHop,
  type TraceNode,
} from '../common/trace/hop.ts';
import type { DeclClassification, ReactPluginApi } from '../plugins/react/plugin.ts';
import type { JsxChildSite, TsPluginApi, TsTargetInput } from '../plugins/ts/plugin.ts';

const SYN_PROV: Provenance = { kind: 'syntactic' }; // jsxChildSites + classify are syntactic
const DEPTH_CAP = 12; // forwarding-chain backstop (never-hang) — paired with the visited set
const NODE_CAP = 300; // total-hop backstop for a wide fan-out tree

export type PropTraceResult = {
  hops: TraceHop[];
  /** Distinct downstream COMPONENT nodes the prop flows into (NOT sinks, NOT the root). */
  reaches: number;
  /** Hops flagged `dynamic` (rename / spread / derived) — the honesty headline. */
  dynamicHops: number;
  /** Is `prop` a declared prop of the root component? `undefined` when unreadable. */
  propDeclared: boolean | undefined;
  notes: string[];
  truncated: boolean;
};

function locTarget(span: Span): TsTargetInput {
  return { file: span.file, line: span.line, col: span.col };
}

/** How one child site forwards the incoming prop, or `undefined` (no flow at this site). `recurse`
 *  is true only when the prop's IDENTITY survives the hop (as-is / rename) — a spread loses the
 *  name, a derived expression transforms the value, so both stop the descent. */
type Forward = {
  relation: 'passes' | 'renames' | 'spreads' | 'derives';
  childProp?: string;
  confidence: Confidence;
  note?: string;
  recurse: boolean;
};

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** A `prop` token appears in `text` at a word boundary (the derived-expression test). */
function mentions(text: string, prop: string): boolean {
  return new RegExp(`\\b${escapeRegExp(prop)}\\b`).test(text);
}

function detectForward(site: JsxChildSite, prop: string): Forward | undefined {
  // 1. An explicit `name={prop}` / `name={props.prop}` attribute — identity preserved (recurse).
  for (const a of site.attrs) {
    if (a.valueIdent !== prop && a.valueMember !== prop) continue;
    const spreadNote = site.hasSpread ? ' (+ {...spread} also present)' : '';
    if (a.name === prop) {
      return {
        relation: 'passes',
        childProp: a.name,
        confidence: 'partial',
        note: `as-is (syntactic identifier; not type-resolved)${spreadNote}`,
        recurse: true,
      };
    }
    return {
      relation: 'renames',
      childProp: a.name,
      confidence: 'dynamic',
      note: `renamed ${prop}→${a.name}${spreadNote}`,
      recurse: true,
    };
  }
  // 2. A `{...spread}` — any prop may flow, under an unknown name (cannot recurse).
  if (site.hasSpread) {
    return {
      relation: 'spreads',
      confidence: 'dynamic',
      note: 'via {...spread} — any prop may flow; child prop name unknown',
      recurse: false,
    };
  }
  // 3. The prop appears inside an attribute EXPRESSION but not as a bare identifier — derived,
  //    value transformed (cannot recurse on the same identity).
  for (const a of site.attrs) {
    if (a.valueIdent === undefined && a.valueText !== undefined && mentions(a.valueText, prop)) {
      return {
        relation: 'derives',
        childProp: a.name,
        confidence: 'dynamic',
        note: `'${prop}' used in an expression (${a.valueText}) — value transformed`,
        recurse: false,
      };
    }
  }
  return undefined;
}

/** Walk `prop` down from the `root` component. `maxDepth` bounds the forwarding chain. */
export function walkPropTrace(
  root: DeclClassification,
  prop: string,
  ts: TsPluginApi,
  react: ReactPluginApi,
  maxDepth: number = DEPTH_CAP,
): PropTraceResult {
  const hops: TraceHop[] = [];
  const notes: string[] = [];
  const reached = new Set<string>();
  const visited = new Set<string>();
  let truncated = false;

  const propDeclared = checkPropDeclared(ts, root.span, prop, notes);
  const rootNode = makeNode({ kind: root.kind, label: root.name, span: root.span });
  visited.add(`${rootNode.key}|${prop}`);

  const walk = (parent: TraceNode, parentSpan: Span, incoming: string, depth: number): void => {
    if (hops.length >= NODE_CAP) {
      truncated = true;
      return;
    }
    const out = ts.jsxChildSites(locTarget(parentSpan));
    if (typeof out === 'string' || !('view' in out)) {
      notes.push(
        `${parent.label}: could not read body (${typeof out === 'string' ? out : out.unresolved})`,
      );
      return;
    }
    const v = out.view;
    if (v.noBody) {
      notes.push(`${parent.label}: no function body to scan`);
      return;
    }
    if (v.truncated !== undefined) {
      truncated = true;
      notes.push(`${parent.label}: body JSX capped (${v.truncated.shown}/${v.truncated.total})`);
    }
    for (const site of v.sites) {
      if (hops.length >= NODE_CAP) {
        truncated = true;
        return;
      }
      const fwd = detectForward(site, incoming);
      if (fwd === undefined) continue;
      const cls = react.classify(locTarget(site.tagSpan));
      if (typeof cls === 'string' || cls.kind !== 'component') {
        // host element / non-component / unresolved tag — the prop reaches a leaf here.
        const sink = makeNode({ kind: 'sink', label: `<${site.tagName}>`, span: site.tagSpan });
        hops.push(hopOf(parent, sink, fwd));
        continue;
      }
      const child = makeNode({ kind: 'component', label: cls.name, span: cls.span });
      hops.push(hopOf(parent, child, fwd));
      reached.add(child.key);
      if (!fwd.recurse) continue;
      const childProp = fwd.childProp ?? incoming;
      const visitKey = `${child.key}|${childProp}`;
      if (visited.has(visitKey)) continue; // diamond / cycle — edge emitted, subtree not re-walked
      visited.add(visitKey);
      if (depth + 1 >= maxDepth) {
        truncated = true;
        notes.push(`${cls.name}: depth cap (${maxDepth}) — deeper forwarding not expanded`);
        continue;
      }
      walk(child, cls.span, childProp, depth + 1);
    }
  };

  walk(rootNode, root.span, prop, 0);
  const deduped = dedupHops(hops);
  return {
    hops: deduped,
    reaches: reached.size,
    dynamicHops: deduped.filter((h) => h.confidence === 'dynamic').length,
    propDeclared,
    notes,
    truncated,
  };
}

function hopOf(from: TraceNode, to: TraceNode, fwd: Forward): TraceHop {
  return makeHop({
    from,
    to,
    relation: fwd.relation,
    confidence: fwd.confidence,
    provenance: SYN_PROV,
    ...(fwd.note !== undefined ? { note: fwd.note } : {}),
  });
}

/** Is `prop` a declared prop of the root? A cheap discriminator (advisor): "root has no such prop"
 *  and "has it but doesn't forward it" are different answers an empty trace would conflate. */
function checkPropDeclared(
  ts: TsPluginApi,
  rootSpan: Span,
  prop: string,
  notes: string[],
): boolean | undefined {
  const out = ts.firstParamTypeMembers(locTarget(rootSpan));
  if (typeof out === 'string' || !('view' in out)) {
    notes.push(`could not read declared props (${typeof out === 'string' ? out : out.unresolved})`);
    return undefined;
  }
  if (out.view.noParam) {
    notes.push(`root takes no props parameter — '${prop}' is not a declared prop`);
    return false;
  }
  const declared = out.view.members.some((m) => m.name === prop);
  if (!declared) {
    notes.push(
      `'${prop}' is not among the root's declared props — tracing the identifier as written`,
    );
  }
  return declared;
}
