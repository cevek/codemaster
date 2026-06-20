// Renderers for invalidations_for (react-query). The data stays structured (raw QueryKeyView +
// Spans — proof + json-mode + sql intact); only the TEXT collapses. Mutation/edge keep their
// real hierarchy (the `edges`/`affects` tree), so they return a structured value with the small
// scalar verdict on the bullet line and the children beneath; the leaf affected-query collapses
// to one line.

import type { JsonValue } from '../../../core/json.ts';
import type { ShapeRenderer } from './types.ts';
import { confTail, isObject, summarizeQueryKey } from './helpers.ts';

/** ResolvedMutation: { id, name, site, edges }. The id carries name + decl loc, so name/site
 *  drop; the `edges (N):` tree header stays (the hierarchy is real). */
export const rqMutation: ShapeRenderer = (v) => ({
  id: v['id'] ?? null,
  edges: v['edges'] ?? null,
});

/** ResolvedInvalidation (edge): { method, key?, all, exact, narrowed, span, affects }. Fold the
 *  scalar fan into one `method @span <key> [flags] · conf` line; keep the affects child. */
export const rqEdge: ShapeRenderer = (v) => {
  const broad = v['all'] === true;
  const flags =
    (v['exact'] === true ? ' · exact' : '') + (v['narrowed'] === true ? ' · narrowed' : '');
  const key = broad ? '(all)' : summarizeQueryKey(v['key']);
  const conf = broad ? 'dynamic' : isObject(v['key']) ? String(v['key']['confidence']) : 'dynamic';
  const edge = `${String(v['method'])} @${String(v['span'])} ${key}${flags} · ${conf}`;
  return { edge, affects: v['affects'] ?? null } as JsonValue;
};

/** AffectedQuery (leaf): { id, name, queryKey, site, confidence }. The id carries the query
 *  hook's name + decl loc; the queryKey summarizes to its literal form. One line. */
export const rqAffected: ShapeRenderer = (v) =>
  `${String(v['id'])} · ${summarizeQueryKey(v['queryKey'])}${confTail(v['confidence'])}`;
