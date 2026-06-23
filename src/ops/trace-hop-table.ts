// The shared tabular projection for every `trace_*` op's flat hop list (common/trace/hop.ts). The
// `trace-hop` row is domain-neutral, so its from/relation/to/to_loc/confidence/provenance/note
// projection is too — extracted here so `trace_invalidation` and `trace_type_widening` (and future
// trace ops) share ONE TableSpec + cell helpers instead of each re-deriving the same shape.

import type { JsonValue } from '../core/json.ts';
import type { Cell, TableSpec } from './registry.ts';

// Predicate form (not a value-returning narrower) — TS narrows a `JsonValue` to a record this way
// but not via a ternary in return position (the readonly-array branch leaks); same idiom as
// format/render/shapes/helpers.ts `isObject`.
function isRecord(v: JsonValue | undefined): v is { [k: string]: JsonValue } {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** A hop's provenance as `kind` or `kind:by` (e.g. `heuristic:react-query`). */
export function provStr(p: JsonValue | undefined): string {
  if (!isRecord(p)) return String(p);
  const by = p['by'];
  return typeof by === 'string' && by.length > 0 ? `${String(p['kind'])}:${by}` : String(p['kind']);
}

/** A node's proof `file:line:col`, or `''` when it carries no span. */
export function locStr(node: JsonValue | undefined): string {
  if (!isRecord(node)) return '';
  const span = node['span'];
  if (!isRecord(span)) return '';
  return `${String(span['file'])}:${String(span['line'])}:${String(span['col'])}`;
}

/** A node's agent-facing label. */
export function labelOf(node: JsonValue | undefined): string {
  return isRecord(node) ? String(node['label']) : String(node);
}

/** The `sql`/table projection of a trace's `data.hops` — one row per hop. */
export const traceHopTable: TableSpec<JsonValue> = {
  columns: [
    { name: 'from', type: 'text' },
    { name: 'relation', type: 'text' },
    { name: 'to', type: 'text' },
    { name: 'to_loc', type: 'text' },
    { name: 'confidence', type: 'text' },
    { name: 'provenance', type: 'text' },
    { name: 'note', type: 'text' },
  ],
  rows(data) {
    const hops = (data as { hops?: Record<string, JsonValue>[] }).hops ?? [];
    const out: (readonly Cell[])[] = [];
    for (const h of hops) {
      out.push([
        labelOf(h['from']),
        String(h['relation']),
        labelOf(h['to']),
        locStr(h['to']),
        String(h['confidence']),
        provStr(h['provenance']),
        typeof h['note'] === 'string' ? h['note'] : null,
      ]);
    }
    return out;
  },
};
