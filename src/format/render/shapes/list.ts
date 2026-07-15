// Renderers for the `list` registry rows and the schema endpoint cards. Both collapse at full
// too (a registry/endpoint listing carries no verbatim proof body — just locations + types).

import type { ShapeRenderer } from './types.ts';
import { asArray, confTail, flat } from './helpers.ts';

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

/** One `list_symbols` per-tsconfig group: { config, shown, total, more?, alsoIn?, names }. Renders as
 *  a config header (`config [shown/total]`) + the flat comma-separated NAME blob, so thousands of bare
 *  names fit. The `shown/total` count + the `+N more` marker are the AUTHORITATIVE per-group
 *  truncation signal (§3.4) — placed BEFORE the bulky names line (verdict-first, §12) so the format
 *  char-cap can only ever trim the names tail, never the count. `(shared: also in …)` flags a group
 *  whose files are also included by other tsconfigs (the file's names appear only here — never
 *  double-counted). */
export const symbolCatalogueGroup: ShapeRenderer = (v) => {
  const shown = Number(v['shown']);
  const total = Number(v['total']);
  const count = total > shown ? `${shown}/${total}` : String(shown);
  const alsoIn = asArray(v['alsoIn']).map(String);
  const shared = alsoIn.length > 0 ? ` (shared: also in ${alsoIn.join(', ')})` : '';
  const more = v['more'] !== undefined ? `\n  … ${flat(v['more'])}` : '';
  return `${String(v['config'])} [${count}]${shared}:\n  ${flat(v['names'])}${more}`;
};
