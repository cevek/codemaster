// Renderer for the domain-neutral `trace-hop` tag (every `trace_*` op emits it, §3.3). The data
// stays structured (full from/to nodes + Spans — proof + json + sql intact); only the TEXT
// collapses to one line: `from →relation to @loc · prov[· conf][· note]`. The destination's loc
// is the clickable proof each hop reveals; the source loc is the prior hop's destination, so it
// is elided to keep the chain dense. Structural over JsonValue (the format layer must not import
// common/trace) — mirrors the TraceHop shape.

import type { JsonValue } from '../../../core/json.ts';
import { isObject, spanLoc, confTail, flat } from './helpers.ts';
import type { ShapeRenderer } from './types.ts';

/** `kind` or `kind:by` (the adapter behind a heuristic) — the per-hop provenance, surfaced so an
 *  adapter-inferred link is never mistaken for a type-proven one. */
function provenance(v: JsonValue | undefined): string {
  if (!isObject(v)) return String(v);
  const by = v['by'];
  return typeof by === 'string' && by.length > 0 ? `${String(v['kind'])}:${by}` : String(v['kind']);
}

function label(node: JsonValue | undefined): string {
  return isObject(node) ? String(node['label']) : String(node);
}

function toLoc(node: JsonValue | undefined): string {
  return isObject(node) ? spanLoc(node['span']) : '';
}

export const traceHop: ShapeRenderer = (v) => {
  const rel = String(v['relation']);
  const note = v['note'];
  const noteTail = typeof note === 'string' && note.length > 0 ? ` · ${flat(note)}` : '';
  return (
    `${label(v['from'])} →${rel} ${label(v['to'])} @${toLoc(v['to'])}` +
    ` · ${provenance(v['provenance'])}${confTail(v['confidence'])}${noteTail}`
  );
};
