// Shared leaf helpers for the shape renderers. Pure over JsonValue (the format layer must
// not import plugins) — these are the small primitives the per-domain renderer files reuse.

import type { JsonValue } from '../../../core/json.ts';

export function isObject(value: JsonValue | undefined): value is Record<string, JsonValue> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isJsonArray(value: JsonValue | undefined): value is readonly JsonValue[] {
  return Array.isArray(value);
}

export function asArray(value: JsonValue | undefined): readonly JsonValue[] {
  return value !== undefined && isJsonArray(value) ? value : [];
}

/** Flatten a free-text field (TS message, type string, locale value, reason) to one line — a
 *  newline would otherwise split a collapsed one-liner into orphan, unanchored lines. */
export function flat(value: JsonValue | undefined): string {
  return String(value).replace(/\s+/g, ' ');
}

/** A clickable `file:line:col` from a `span` field that condense may have already collapsed
 *  to a string (terse/normal) OR left as a verbatim span object (`full`). Renderers that
 *  fire at full (the non-proof structural forms) use this so they collapse a name-token span
 *  to its location at every verbosity — the span TEXT there is just the identifier, no proof. */
export function spanLoc(span: JsonValue | undefined): string {
  if (isObject(span))
    return `${String(span['file'])}:${String(span['line'])}:${String(span['col'])}`;
  return String(span);
}

/** `· conf` for a non-`certain` confidence; empty when certain (the implicit default). */
export function confTail(confidence: JsonValue | undefined): string {
  return confidence === 'certain' || confidence === undefined ? '' : ` · ${String(confidence)}`;
}

/** Optional per-usage provenance decorations (Task G program · merge decls) appended to a
 *  usage / group-row line. `program`/`programs` carry the surfacing tsconfig; `decls`
 *  (number[] flat | string group) the merged-declaration indices. Empty when none present. */
export function usageDeco(v: Record<string, JsonValue>): string {
  let s = '';
  const program = v['program'];
  if (typeof program === 'string') s += ` · prog ${program}`;
  const programs = v['programs'];
  if (typeof programs === 'string') s += ` · prog ${programs}`;
  const decls = v['decls'];
  if (decls !== undefined && Array.isArray(decls)) s += ` · decls[${decls.map(String).join(',')}]`;
  else if (typeof decls === 'string' && decls.length > 0) s += ` · decls[${decls}]`;
  s += destructuresDeco(v['destructures']);
  return s;
}

/** The per-call-site return-shape annotation (t-409060): `⇒{a,b}` for destructured props, a trailing
 *  `…` for a `...rest`/computed key, and `⇒whole` for a value bound/passed whole (may use any prop). */
function destructuresDeco(d: JsonValue | undefined): string {
  if (!isObject(d)) return '';
  if (d['whole'] === true) return ' ⇒whole';
  const props = asArray(d['props']).map(String);
  const rest = d['rest'] === true ? (props.length > 0 ? ',…' : '…') : '';
  return ` ⇒{${props.join(',')}${rest}}`;
}

/** Summarize a (condensed) react-query QueryKeyView to its literal form — `['a', <id>]` for
 *  an array key, `<opaque>` for a non-array key, `(all)` when absent. Structural over
 *  JsonValue (the format layer must not import plugins/react-query); MIRRORS
 *  `ops/react-query-invalidations-for`'s `renderKey` (the sql-table renderer). The
 *  render-contract guard cross-pins the two so they can never silently diverge. */
export function summarizeQueryKey(key: JsonValue | undefined): string {
  if (!isObject(key)) return '(all)';
  if (key['opaque'] !== undefined) return `<${String(key['opaque'])}>`;
  const segs = asArray(key['segments']).map((s) =>
    isObject(s) && s['kind'] === 'static'
      ? JSON.stringify(s['value'])
      : isObject(s)
        ? `<${String(s['shape'])}>`
        : String(s),
  );
  return `[${segs.join(', ')}]`;
}
