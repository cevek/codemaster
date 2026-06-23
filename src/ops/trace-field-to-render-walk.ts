// The trace_field_to_render traversal — one hop from a data field to where it is read in JSX. It
// composes the ts `fieldRenderSites` projection (member-level reads + their TSX render position) with
// `react.classify` (is the enclosing declaration a component) and OWNS the per-hop honesty (§3.3):
//
//   field --rendered-in--> Component      a read inside a HOST element (`<span>{u.email}</span>`) — the
//                                         enclosing component renders it (certain; counts in renderedBy)
//   field --passed-to----> <Child/>       a read inside a VALUE element (`<Avatar email={u.email}/>`) —
//                                         handed to a child component, rendered only if IT renders the
//                                         prop (partial; trace onward with trace_prop_through_tree)
//   field --destructured-> {field}        a destructure binding (`const {email}=u`) — the field flows
//                                         into a local whose downstream reads are INVISIBLE to
//                                         member-level references (partial; the op's stated floor)
//
// No recursion: ONE hop, bounded by the (capped) reference set. `renderedBy` counts only the proven
// HOST-render components — the #1 trust point that keeps the boundary with trace_prop_through_tree.

import type { Provenance } from '../core/span.ts';
import {
  dedupHops,
  makeHop,
  makeNode,
  type TraceHop,
  type TraceNode,
} from '../common/trace/hop.ts';
import type { ReactPluginApi } from '../plugins/react/plugin.ts';
import type { TsTargetInput } from '../plugins/ts/plugin.ts';
import type { FieldRenderSitesView, FieldReadSite } from '../plugins/ts/field-render-sites.ts';

const TYPE_PROV: Provenance = { kind: 'type' }; // the field-identity rests on the LS member reference
const SYN_PROV: Provenance = { kind: 'syntactic' }; // a value-element pass / destructure is syntactic

export type FieldRenderResult = {
  hops: TraceHop[];
  /** Distinct components that RENDER the field in a host element — the headline verdict. */
  renderedBy: number;
  /** Distinct sites where the field is handed to a value (child) component as a prop. */
  passedTo: number;
  /** Distinct destructure bindings (downstream reads untraced — the floor). */
  destructured: number;
  /** Member reads outside any JSX position (plain logic) — counted, never claimed as a render. */
  nonRenderReads: number;
  notes: string[];
  truncated: boolean;
};

function locTarget(site: FieldReadSite): TsTargetInput {
  const s = site.enclosing?.span ?? site.span;
  return { file: s.file, line: s.line, col: s.col };
}

export function buildFieldRenderTrace(
  field: TraceNode,
  view: FieldRenderSitesView,
  react: ReactPluginApi,
): FieldRenderResult {
  const hops: TraceHop[] = [];
  const notes: string[] = [];
  const rendered = new Set<string>();
  const passed = new Set<string>();
  let destructured = 0;
  let nonRenderReads = 0;

  for (const site of view.sites) {
    if (site.kind === 'destructure') {
      destructured += 1;
      const leaf = makeNode({ kind: 'destructure', label: `{${field.label}}`, span: site.span });
      hops.push(
        makeHop({
          from: field,
          to: leaf,
          relation: 'destructured-at',
          confidence: 'partial',
          provenance: SYN_PROV,
          note: 'destructured to a local — downstream renders of the local are not traced',
        }),
      );
      continue;
    }
    if (site.kind === 'write') continue; // an assignment to the field is not a render

    if (site.jsx === 'none') {
      nonRenderReads += 1;
      continue;
    }

    const intrinsic = site.jsx === 'intrinsic-child' || site.jsx === 'intrinsic-attr';
    if (intrinsic) {
      const reader = classifyReader(site, react, notes);
      if (reader === undefined) continue;
      const note = readerNote(reader, site);
      hops.push(
        makeHop({
          from: field,
          to: reader.node,
          relation: 'rendered-in',
          confidence: reader.confidence,
          provenance: TYPE_PROV,
          ...(note !== undefined ? { note } : {}),
        }),
      );
      if (reader.isComponent) rendered.add(reader.node.key);
      continue;
    }

    // value element: `<Child email={u.email}/>` — passed onward, not rendered here.
    const tag = site.tag ?? 'Child';
    const receiver = makeNode({ kind: 'jsx-prop', label: `<${tag}/>`, span: site.span });
    passed.add(receiver.key);
    hops.push(
      makeHop({
        from: field,
        to: receiver,
        relation: 'passed-to',
        confidence: 'partial',
        provenance: SYN_PROV,
        note: `passed to value element <${tag}/> — rendered only if it renders the prop (trace_prop_through_tree)`,
      }),
    );
  }

  return {
    hops: dedupHops(hops),
    renderedBy: rendered.size,
    passedTo: passed.size,
    destructured,
    nonRenderReads,
    notes,
    truncated: view.truncated !== undefined,
  };
}

type Reader = { node: TraceNode; isComponent: boolean; confidence: 'certain' | 'partial' };

/** Resolve a render site's enclosing declaration to a reader node via `react.classify` — the same
 *  resolve-THROUGH-the-LS path trace_invalidation uses, never a SymbolId string compare. A
 *  non-component encloser (a bare helper / a hook) is reported but not counted as a render leaf. */
function classifyReader(
  site: FieldReadSite,
  react: ReactPluginApi,
  notes: string[],
): Reader | undefined {
  const cls = react.classify(locTarget(site));
  if (typeof cls === 'string') {
    notes.push(`reader not classified at ${site.span.file}:${site.span.line}: ${cls}`);
    return undefined;
  }
  const node = makeNode({ kind: cls.kind, label: cls.name, span: cls.span });
  const isComponent = cls.kind === 'component';
  const confidence = isComponent && cls.confidence !== 'certain' ? 'partial' : 'certain';
  return { node, isComponent, confidence };
}

/** The per-hop why when a render hop is not a clean host-child render — a host ATTRIBUTE, a wrapped
 *  component, or a non-component encloser — surfaced on the hop, never silent (§3.3). */
function readerNote(reader: Reader, site: FieldReadSite): string | undefined {
  if (!reader.isComponent)
    return `read in a ${reader.node.kind}, not a component — rendered where its value is used (trace_prop_through_tree)`;
  if (reader.confidence !== 'certain')
    return 'wrapped/indirect component — JSX inferred, not directly returned';
  if (site.jsx === 'intrinsic-attr')
    return `bound to a host attribute (<${site.tag ?? ''} …={…}/>)`;
  return undefined;
}
