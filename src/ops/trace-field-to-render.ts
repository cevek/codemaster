// `trace_field_to_render` — trace a DATA FIELD (a property of an object type) to where it is read in
// JSX: which components render it on screen (§17 Phase 6). "Field `User.email` — which components put
// it on the page." It is a different PROJECTION of the same LS member-reference primitive find_usages
// rides (member-level by construction, alias-safe), tagged with the TSX render position of each read.
//
// HONESTY (§3.3) — the verdict is a LOWER BOUND, stated plainly:
//  - host element (`<span>{u.email}</span>`)  → rendered-in, certain, counts in `renderedBy`;
//  - value element (`<Avatar email={u.email}/>`) → passed-to, partial, NOT counted (the receiving
//    component decides — trace onward with trace_prop_through_tree). The #1 trust point.
//  - destructure (`const {email}=u`) and dynamic (`u[k]`, spread `{...u}`) reads are INVISIBLE to
//    member-level references and are flagged / floored, never counted as a proven render.

import { z } from 'zod';
import type { JsonValue } from '../core/json.ts';
import { failFromThrown, fail, ok } from '../common/result/construct.ts';
import { makeNode } from '../common/trace/hop.ts';
import { tag } from '../common/shape-tag/tag.ts';
import { classifyTargetString, targetFields } from './intake/smart-string.ts';
import type { ReactPluginApi } from '../plugins/react/plugin.ts';
import type { TsPluginApi, TsTargetInput } from '../plugins/ts/plugin.ts';
import { defineOp } from './registry.ts';
import { semanticFanoutRefusal } from './guard/semantic-fanout-guard.ts';
import { traceHopTable } from './trace-hop-table.ts';
import { buildFieldRenderTrace } from './trace-field-to-render-walk.ts';

// The standing floor — `renderedBy` can only ever be a lower bound, so it is stated on EVERY answer
// (rider): the reads member-level references cannot follow are named with the onward path.
const FLOOR_NOTE =
  'renderedBy is a LOWER BOUND: destructured reads (`const {email}=u`) and dynamic reads (`u[k]`, spread `{...u}`) are not traced to a render — for destructure-forwarded renders use trace_prop_through_tree or address the local. Never a render claimed where the access is dynamic.';

const argsSchema = z.strictObject({
  field: z.string(),
  /** Bypass the in-process semantic-fanout size guard (t-411303) and warm anyway. */
  force: z.boolean().optional(),
});

export const traceFieldToRenderOp = defineOp({
  name: 'trace_field_to_render',
  summary: 'Trace a data field (object-type property) to the components that render it in JSX',
  mutating: false,
  requires: ['react'],
  argsSchema,
  argsHint: '{ field: string, force?: boolean }',
  example: { args: { field: 'src/types.ts:1:25' } },
  notes: [
    'on an oversized IN-PROCESS repo (> `ts.searchWarmMaxFiles`, default 4000 source files) this op REFUSES to warm (the member reference scan fans across every program and would OOM, killing the daemon) and says WHY it was not auto-escalated into a killable child (t-754922) plus the one remedy for that cause. `force:true` does NOT override it (forcing killed the daemon in production). No refusal in an escalated / configured process-mode child.',
    'field addresses the PROPERTY declaration — a SymbolId, a `path:line:col`, or a bare property name (resolved only when unambiguous). A target that does NOT resolve (absent, ambiguous, or not a property) is a FAIL naming why — never an ok{found:0}, which would be indistinguishable from a field that resolved and is rendered nowhere. found:0 means the trace ran and proved no render.',
    'renderedBy counts the components that render the field in a HOST element (`<span>{u.email}</span>`). A read inside a VALUE element (`<Avatar email={u.email}/>`) is passed-to (partial) — the child decides the render, so it is NOT counted; follow it with trace_prop_through_tree.',
    'every hop carries per-hop confidence + provenance (rendered-in = type/LS member ref; passed-to/destructured = syntactic). A destructure binding, a host-attribute bind, or a wrapped/indirect component is flagged on its hop, never silently treated as a clean render.',
    'renderedBy is a lower bound — destructured/dynamic/spread reads are invisible to member-level references and are floored (an honest standing note), never counted as a proven render.',
  ],
  table: traceHopTable,
  async run(ctx, args) {
    const ts = ctx.plugins.get<TsPluginApi>('ts');
    const react = ctx.plugins.get<ReactPluginApi>('react');
    // Pre-warm guard (t-411303): `fieldRenderSites` rides `findReferencesAcross`, fanning member
    // references across every program — on an oversized in-process repo that OOMs and kills the
    // daemon (§1). Refuse BEFORE any resolve/warm, naming why the repo was not auto-escalated. `force` does NOT override it (t-693742).
    const refusal = semanticFanoutRefusal(ctx, ts, args.force);
    if (refusal !== undefined) return fail(refusal);
    try {
      const target = targetFields(classifyTargetString(args.field)) as TsTargetInput;

      // A target that did not resolve is a "couldn't", and it must reach the agent AS one (§3.6).
      // Returning `ok{found:0, renderedBy:0}` here would make the shape of "we could not find out"
      // identical to the shape of "this field is rendered nowhere" — and an agent acting on the
      // second deletes code. That is worse than an incomplete answer: it is a positive claim about
      // the repo that nothing established. `found:0` stays reserved for a field that DID resolve
      // and genuinely has no render sites, which is a fact the trace actually proved.
      const def = ts.findDefinition(target);
      if (typeof def === 'string') return fail({ tool: 'ts-ls', message: def });
      if (!('views' in def)) {
        return fail({ tool: 'ts-ls', message: def.unresolved }, { handle: def.rebind });
      }
      const fieldView = def.views[0];
      if (fieldView === undefined) {
        return fail({
          tool: 'ts-ls',
          message: `no declaration at the target '${args.field}' — address the property by SymbolId or file:line:col`,
        });
      }
      const label =
        fieldView.container !== undefined
          ? `${fieldView.container}.${fieldView.name}`
          : fieldView.name;
      const fieldNode = makeNode({ kind: 'field', label, span: fieldView.span, id: fieldView.id });

      const sitesOut = ts.fieldRenderSites(target);
      if (typeof sitesOut === 'string') return fail({ tool: 'ts-ls', message: sitesOut });
      if (!('view' in sitesOut)) {
        return fail({ tool: 'ts-ls', message: sitesOut.unresolved }, { handle: sitesOut.rebind });
      }

      const walked = buildFieldRenderTrace(fieldNode, sitesOut.view, react);
      const notes = [...walked.notes, FLOOR_NOTE];
      // Verdict-before-bulk (§12): the scalar verdict renders FIRST, the (re-fetchable) hop list LAST,
      // so the hard char-cap can only ever truncate hops, never the headline / notes.
      const data: Record<string, JsonValue> = {
        field: label,
        found: 1,
        renderedBy: walked.renderedBy,
        passedToComponents: walked.passedTo,
        destructuredReads: walked.destructured,
        nonRenderReads: walked.nonRenderReads,
        truncated: walked.truncated,
        notes,
        hops: walked.hops.map((h) => tag('trace-hop', h)),
      };
      return ok(data);
    } catch (thrown) {
      return failFromThrown('ts', thrown);
    }
  },
});
