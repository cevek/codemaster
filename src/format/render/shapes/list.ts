// Renderers for the `list` registry rows and the schema endpoint cards. Both collapse at full
// too (a registry/endpoint listing carries no verbatim proof body — just locations + types).

import type { ShapeRenderer } from './types.ts';
import { confTail, flat } from './helpers.ts';

/** ListEntry (the `list` registry op): { key, confidence, file, line, col, proof, kind?,
 *  provenance?, name?, segments?, detail? }. No `id` to fold name+loc into, so it exploded into
 *  a k=v line per field — collapse to one clickable line. `proof` repeats file:line:col and
 *  `name` repeats `key`; both dropped. kind/provenance ride the tail but are omitted when the op
 *  hoisted them as uniform (allKind/allProvenance). */
export const listEntry: ShapeRenderer = (v) => {
  const loc = `${String(v['file'])}:${String(v['line'])}:${String(v['col'])}`;
  const kind = v['kind'] !== undefined ? ` · ${String(v['kind'])}` : '';
  const prov = v['provenance'] !== undefined ? ` · ${String(v['provenance'])}` : '';
  const detail = v['detail'] !== undefined ? ` · ${flat(v['detail'])}` : '';
  return `${String(v['key'])}${kind} · ${loc}${confTail(v['confidence'])}${prov}${detail}`;
};

/** EndpointCard (list_endpoints) — { method, path, pathParams, query?, body?, response?, status?,
 *  confidence, note? }. query/body/response are TypeRefs already collapsed to `loc · type` — show
 *  just the type. */
export const endpointCard: ShapeRenderer = (v) => {
  const typeText = (s: string): string => {
    const i = s.indexOf(' · ');
    return i >= 0 ? s.slice(i + 3) : s;
  };
  const ref = (key: string, label: string): string =>
    v[key] !== undefined ? ` · ${label}=${typeText(String(v[key]))}` : '';
  const status = v['status'] !== undefined ? ` →${String(v['status'])}` : '';
  const note = v['note'] !== undefined ? ` · ${flat(v['note'])}` : '';
  return `${String(v['method'])} ${String(v['path'])}${status}${ref('query', 'q')}${ref('body', 'body')}${ref('response', 'resp')}${confTail(v['confidence'])}${note}`;
};
