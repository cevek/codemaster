// `trace_prop_through_tree` — the proof-carrying trace of a PROP flowing DOWN a component tree: a
// component receives a prop → forwards it (as-is / renamed / via `{...spread}` / in a derived
// expression) to its rendered children → recurse while the prop's identity survives. "Where does
// `userId` from `<App>` go." A Phase 6 trace op (§17); it reuses the domain-neutral trace-hop
// contract (common/trace/hop.ts), the single `trace-hop` render tag, and the shared hop table
// (trace-hop-table.ts) — adding capability without a new render tag or table.
//
// HONESTY (§3.3 / §3.4): the forward is SYNTACTIC, so as-is is `partial` (a same-named local could
// shadow) and rename / spread / derived are `dynamic`, each flagged on its hop — never silently
// bridged. The seam OVER-collects body JSX (callbacks, render props), so an indirect forward is
// not dropped (a completeness lie). The whole walk is bounded (depth + visited + node caps →
// `truncated`).

import { z } from 'zod';
import { failFromThrown, ok } from '../common/result/construct.ts';
import { tag } from '../common/shape-tag/tag.ts';
import type { ReactPluginApi } from '../plugins/react/plugin.ts';
import type { TsPluginApi } from '../plugins/ts/plugin.ts';
import { defineOp } from './registry.ts';
import { requireTarget, targetOf, tsTargetIntake, tsTargetShape } from './ts-target.ts';
import { traceHopTable } from './trace-hop-table.ts';
import { walkPropTrace } from './trace-prop-through-tree-walk.ts';

export const tracePropThroughTreeOp = defineOp({
  name: 'trace_prop_through_tree',
  summary:
    'Trace a prop DOWN the component tree: the component that receives it → forwards it (as-is / renamed / via spread) to children → recurse',
  mutating: false,
  requires: ['react'],
  argsSchema: z
    .strictObject({
      ...tsTargetShape,
      prop: z.string().min(1),
      depth: z.number().int().positive().max(50).optional(),
    })
    .refine(requireTarget.predicate, { message: requireTarget.message }),
  argsHint: '{ name|symbolId|file+line (the component), prop: string, depth?: number }',
  intake: tsTargetIntake,
  example: { args: { name: 'App', prop: 'userId' } },
  notes: [
    'addresses the component that RECEIVES the prop (by name / SymbolId / file+line, like every symbol-addressed op); prop is the prop name as that component receives it. A target that is not a component (a hook / other) → found:0 + an honest note, never a faked trace.',
    'every hop is SYNTACTIC and flagged: an as-is `name={prop}` forward is `partial` (a same-named local could shadow — not type-resolved); a RENAME, a `{...spread}` (child prop name unknown), and a DERIVED expression (`{prop.x}`/`{f(prop)}`) are each `dynamic` with the reason in `note`. dynamicHops counts them.',
    'reaches counts the distinct downstream COMPONENT nodes the prop flows into; a `<host/>` element (a DOM tag) or a non-component tag is a flow SINK leaf (the prop is rendered there), never recursed.',
    'propDeclared says whether prop is a declared prop of the root — "no such prop" and "has it but does not forward it" are different answers an empty trace would otherwise conflate.',
    'COVERAGE: ATTRIBUTE-position forwarding only. A prop passed as the `children` value — `<Child>{prop}</Child>` (children={prop}) — is NOT traced (no hop; that flow is silently absent). A nested ELEMENT child IS caught, since the scan descends: `<Wrap><Inner x={prop}/></Wrap>` traces App→Inner via the `x` attribute.',
    'the walk over-collects body JSX (incl. `.map(...)` callbacks and render props), so an indirect attribute forward is not dropped; it is bounded by a depth cap (default 12, override with depth), a (component|prop) visited set (a recursive / diamond tree never loops), and a total-hop cap → truncated:true + a note.',
  ],
  table: traceHopTable,
  async run(ctx, args) {
    const react = ctx.plugins.get<ReactPluginApi>('react');
    const ts = ctx.plugins.get<TsPluginApi>('ts');
    try {
      const root = react.classify(targetOf(args));
      if (typeof root === 'string') {
        return ok({ prop: args.prop, found: 0, notes: [root], hops: [] });
      }
      if (root.kind !== 'component') {
        return ok({
          prop: args.prop,
          found: 0,
          notes: [
            `'${root.name}' is a ${root.kind}, not a component — address the component that receives the prop`,
          ],
          hops: [],
        });
      }
      const res = walkPropTrace(root, args.prop, ts, react, args.depth);
      // Verdict-before-bulk (§12): the scalar verdict renders FIRST, the (re-fetchable) hop list
      // LAST, so the hard char-cap can only ever truncate hops, never the headline / freshness.
      const data = {
        prop: args.prop,
        component: root.name,
        found: 1,
        ...(res.propDeclared !== undefined ? { propDeclared: res.propDeclared } : {}),
        reaches: res.reaches,
        dynamicHops: res.dynamicHops,
        truncated: res.truncated,
        ...(res.notes.length > 0 ? { notes: res.notes } : {}),
        hops: res.hops.map((h) => tag('trace-hop', h)),
      };
      return ok(data);
    } catch (thrown) {
      return failFromThrown('react', thrown);
    }
  },
});
