// `trace_invalidation` — the full proof-carrying trace from a react-query mutation to the
// components that re-render: mutation → invalidates → queryKey → affects → useQuery → its host
// component (directly, or through the custom hook that wraps it) → that component's `<Host/>`
// mount sites. The FIRST trace op (Phase 6, §17): it lays the domain-neutral trace-hop contract
// (common/trace/hop.ts) every Wave-2b trace op reuses, and the one `trace-hop` render tag.
//
// HONESTY (§3.3): every hop carries its own confidence + provenance, flagged at the step the
// uncertainty arises — a broad `invalidateQueries()`, a dynamic key segment, an opaque mount ref,
// a hook-chain depth cap — never silently bridged. THE #1 TRUST POINT: a mount site `<Host/>` is
// the PARENT's placement; the parent does NOT re-render from the invalidation. `reRenderComponents`
// counts the subscriber hosts/consumers, NEVER the mount locations (stated in the notes below).

import { z } from 'zod';
import { failFromThrown, fail, ok } from '../common/result/construct.ts';
import { tag } from '../common/shape-tag/tag.ts';
import type { ReactPluginApi } from '../plugins/react/plugin.ts';
import type { ReactQueryPluginApi } from '../plugins/react-query/plugin.ts';
import type { TsPluginApi } from '../plugins/ts/plugin.ts';
import { defineOp } from './registry.ts';
import { semanticFanoutRefusal } from './guard/semantic-fanout-guard.ts';
import { traceHopTable } from './trace-hop-table.ts';
import { walkInvalidationTrace } from './trace-invalidation-walk.ts';

export const traceInvalidationOp = defineOp({
  name: 'trace_invalidation',
  summary:
    'Trace a mutation → invalidated queryKeys → affected useQuery → host components → their mount sites',
  mutating: false,
  requires: ['react-query', 'react'],
  argsSchema: z.strictObject({
    mutation: z.string(),
    /** Bypass the in-process semantic-fanout size guard (t-411303) and warm anyway. */
    force: z.boolean().optional(),
  }),
  argsHint: '{ mutation: string, force?: boolean }',
  example: { args: { mutation: 'useCreateTodo' } },
  notes: [
    "on an oversized IN-PROCESS repo (> `ts.searchWarmMaxFiles`, default 4000 source files) this op REFUSES to warm (its walk fans find_usages / JSX references across every program and would OOM, killing the daemon) and redirects to `daemon.isolation:'process'`; pass `force:true` to warm anyway. No refusal in process-mode.",
    'mutation is resolved by its ENCLOSING declaration name (the hook holding useMutation), or a callId/SymbolId — like invalidations_for, which this builds on. 0 matches → found:0, never a faked empty trace.',
    'reRenderComponents counts the SUBSCRIBER hosts (the component holding useQuery, or the component consuming the custom hook that holds it) — NOT the mount sites. A `<Host/>` mount is the PARENT placement; the parent does not re-render from the invalidation, so a mounted-at hop is a LOCATION leaf, never counted.',
    'every hop carries per-hop confidence + provenance: invalidates/affects = heuristic:react-query, used-by = type (LS references), mounted-at = syntactic (JSX scan). A broad invalidateQueries(), a dynamic key segment, an opaque mount ref (alias/factory/spread), or a hook-chain past the depth cap is FLAGGED on its hop (note + non-certain confidence), never silently bridged or dropped.',
    'hook→hook consumer chains are bounded (depth cap + a global visited set) and truncation is reported (truncated:true + a note); a component with no static mount site is an honest note (root / route element), not a guessed hop.',
  ],
  table: traceHopTable,
  async run(ctx, args) {
    const rq = ctx.plugins.get<ReactQueryPluginApi>('react-query');
    const react = ctx.plugins.get<ReactPluginApi>('react');
    const ts = ctx.plugins.get<TsPluginApi>('ts');
    // Pre-warm guard (t-411303): the trace walk fans find_usages / JSX references across every
    // program — on an oversized in-process repo that OOMs and kills the daemon (§1). Refuse with a
    // process-mode redirect BEFORE any resolve/warm. `force` bypasses (see the guard).
    const refusal = semanticFanoutRefusal(ctx, ts, args.force);
    if (refusal !== undefined) return fail(refusal);
    try {
      const view = rq.invalidationsFor(args.mutation);
      const notes: string[] = [];
      if (!view.moduleResolved) {
        notes.push(
          "'@tanstack/react-query' did not resolve — no react-query call could be matched; results are not authoritative",
        );
      }
      if (view.mutations.length === 0) {
        notes.push(
          `no mutation matched '${args.mutation}' — give the enclosing declaration name (the hook holding useMutation), a callId, or a SymbolId`,
        );
      }
      if (view.dynamicKeyedQueries > 0) {
        notes.push(
          `${view.dynamicKeyedQueries} query(ies) have computed (dynamic) keys — a concrete invalidation here MAY also affect them; they cannot be matched statically and are not in the trace`,
        );
      }
      const walked = walkInvalidationTrace(view, ts, react);
      notes.push(...walked.notes);
      // Verdict-before-bulk (§12): the scalar verdict renders FIRST, the (re-fetchable) hop list
      // LAST, so the hard char-cap can only ever truncate hops, never the headline / freshness.
      const data = {
        mutation: args.mutation,
        found: view.mutations.length,
        moduleResolved: view.moduleResolved,
        reRenderComponents: walked.reRenderComponents,
        dynamicKeyedQueries: view.dynamicKeyedQueries,
        truncated: walked.truncated,
        ...(notes.length > 0 ? { notes } : {}),
        hops: walked.hops.map((h) => tag('trace-hop', h)),
      };
      return ok(data);
    } catch (thrown) {
      return failFromThrown('react-query', thrown);
    }
  },
});
