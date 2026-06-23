// `invalidations_for` — for a mutation (named by its enclosing declaration, or a SymbolId/callId),
// the query keys it invalidates and the queries those keys affect (react-query plugin). The
// mutation→key→query chain is proof-carrying and per-hop honest: a static queryKey proven against
// a static query prefix is `certain`; a dynamic segment, or a broad `invalidateQueries()` with no
// key, is `partial`/`dynamic` — flagged, never asserted (§3.3). A dynamic queryKey is never guessed.

import { z } from 'zod';
import type { JsonValue } from '../core/json.ts';
import { failFromThrown, ok } from '../common/result/construct.ts';
import { tag } from '../common/shape-tag/tag.ts';
import type { ReactQueryPluginApi } from '../plugins/react-query/plugin.ts';
import type { QueryKeyView, ResolvedMutation } from '../plugins/react-query/views.ts';
import { defineOp } from './registry.ts';
import type { Cell, TableSpec } from './registry.ts';

/** Render a queryKey for the flat table: `['todos', <identifier>]`, `<call>` for an opaque key,
 *  `(all)` for a broad invalidation. Exported only so the render-contract guard can cross-pin it
 *  against condense's `summarizeQueryKey` (its intentional structural twin — see that fn). */
export function renderKey(key: QueryKeyView | undefined, all: boolean): string {
  if (all || key === undefined) return '(all)';
  if (key.opaque !== undefined) return `<${key.opaque}>`;
  const segs = key.segments.map((s) =>
    s.kind === 'static' ? JSON.stringify(s.value) : `<${s.shape}>`,
  );
  return `[${segs.join(', ')}]`;
}

const invalidationsForTable: TableSpec<JsonValue> = {
  columns: [
    { name: 'mutation', type: 'text' },
    { name: 'method', type: 'text' },
    { name: 'key', type: 'text' },
    { name: 'broad', type: 'int' },
    { name: 'affects', type: 'text' },
    { name: 'confidence', type: 'text' },
  ],
  rows(data) {
    const mutations = (data as { mutations?: ResolvedMutation[] }).mutations ?? [];
    const out: (readonly Cell[])[] = [];
    for (const m of mutations) {
      for (const e of m.edges) {
        const key = renderKey(e.key, e.all);
        const broad = e.all ? 1 : 0;
        if (e.affects.length === 0) {
          out.push([m.name, e.method, key, broad, null, e.confidence]);
        } else {
          for (const a of e.affects) out.push([m.name, e.method, key, broad, a.name, a.confidence]);
        }
      }
    }
    return out;
  },
};

export const invalidationsForOp = defineOp({
  name: 'invalidations_for',
  summary: 'For a mutation: the query keys it invalidates and the queries those keys affect',
  mutating: false,
  requires: ['react-query'],
  argsSchema: z.strictObject({ mutation: z.string() }),
  argsHint: '{ mutation: string }',
  example: { args: { mutation: 'useCreateTodo' } },
  notes: [
    'mutation is resolved by its ENCLOSING declaration name (the custom hook / function holding the useMutation), or a callId/SymbolId. 0 matches → reported honestly (found:0), never an empty success dressed as "invalidates nothing".',
    'detection is import-anchored to @tanstack/react-query (by identity), so a same-named useQuery/useMutation from another module is NOT mistaken for react-query; qc.invalidateQueries() matches via the useQueryClient binding. If the module does not resolve, moduleResolved:false and results are NOT authoritative.',
    'per-hop confidence: a static queryKey proven to prefix a static query key is certain; a dynamic segment (identifier/template/computed) on either side is partial; a broad invalidateQueries() with no key affects every query (dynamic). A dynamic key segment is flagged, never resolved to a guessed value.',
    'invalidation is a PREFIX filter (react-query semantics): a query is affected iff its key starts with the invalidation key. new QueryClient() receivers are not yet matched (only useQueryClient()) — a deferred limit.',
  ],
  table: invalidationsForTable,
  async run(ctx, args) {
    const rq = ctx.plugins.get<ReactQueryPluginApi>('react-query');
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
          `${view.dynamicKeyedQueries} query(ies) have computed (dynamic) keys — a concrete invalidation here MAY also affect them; they cannot be matched statically and are not listed under affects`,
        );
      }
      // Verdict-before-bulk (§12): found/moduleResolved render FIRST, the (re-fetchable) mutation
      // detail last, so the hard char-cap can only truncate the tail, never the verdict.
      const data = {
        found: view.mutations.length,
        moduleResolved: view.moduleResolved,
        dynamicKeyedQueries: view.dynamicKeyedQueries,
        ...(notes.length > 0 ? { notes } : {}),
        mutations: view.mutations.map((m) =>
          tag('rq-mutation', {
            ...m,
            edges: m.edges.map((e) =>
              tag('rq-edge', { ...e, affects: e.affects.map((a) => tag('rq-affected', a)) }),
            ),
          }),
        ),
      };
      return ok(data);
    } catch (thrown) {
      return failFromThrown('react-query', thrown);
    }
  },
});
