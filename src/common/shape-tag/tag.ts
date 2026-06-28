// Shape tagging — the render dispatch contract (output-density umbrella, §12).
//
// The dense text renderer (`format/render/condense.ts`) must turn each result ROW into
// one coded line. It used to GUESS the row's shape from its key-set; that silently leaked
// new/changed shapes into render-dense's multi-line `key=value` exploder. Instead every
// renderable row now carries a stable `~shape` TAG, stamped by the op that builds it, and
// condense dispatches tag → renderer. An unknown tag fails LOUD, never a silent explode.
//
// The tag is META, not data: a reserved `~`-prefixed key (the same "not a name/path/number"
// idiom the SymbolId uses for its `~rootTag` suffix). It must be a real ENUMERABLE field so
// it survives the IPC/NDJSON hop to the renderer (process-mode), so json mode strips every
// `~`-key before serializing (`stripShapeTags`) and the sql projector — explicit columns —
// never reaches it. Text mode is the only consumer.

import type { JsonValue } from '../../core/json.ts';

/** The reserved meta key. `~` never occurs in a path / identifier / number, so it can't
 *  collide with a real data field. */
export const SHAPE_KEY = '~shape';

/** Every renderable row shape. A `Record<ShapeTag, renderer>` registry (format/render/
 *  shapes) is exhaustive over this union, so a NEW tag with no renderer is a COMPILE error —
 *  the first half of the coverage guard (the runtime guard catches forgot-to-tag). */
export type ShapeTag =
  // ts read-side
  | 'symbol'
  | 'usage'
  | 'text-hit'
  | 'group-row'
  | 'importer'
  | 'subtree-importer'
  | 'subtree-unconfirmed'
  | 'construction-site'
  | 'unused-export'
  | 'type-member'
  | 'type-ref'
  | 'unresolved-name'
  | 'bare-span'
  | 'target-ref'
  // diagnostics (cross-domain)
  | 'ts-diagnostic'
  | 'parse-failure'
  // mutating
  | 'capture'
  | 'name-survives'
  | 'typecheck-clean'
  | 'touched-stat'
  // i18n
  | 'i18n-unused-key'
  | 'i18n-def'
  | 'i18n-usage'
  | 'i18n-missing-per-key'
  | 'i18n-missing-usage'
  // scss / css-cascade
  | 'scss-class'
  | 'css-rule'
  | 'css-property'
  | 'css-winner'
  | 'css-decl-ref'
  | 'css-left-behind'
  | 'css-coextract'
  // react
  | 'unused-prop'
  // react-query
  | 'rq-mutation'
  | 'rq-edge'
  | 'rq-affected'
  // trace (domain-neutral — one tag for every trace_* op)
  | 'trace-hop'
  // list / schema
  | 'list-entry'
  | 'endpoint-card';

/** Stamp a row with its shape tag. SPREADS (never mutates) — a row may be plugin
 *  cache-state, and writing the tag in place would corrupt that cache and violate
 *  tear-free reads (§19). The tag is appended LAST, so stripping it later restores the
 *  original key order byte-for-byte. */
export function tag<T extends object>(shape: ShapeTag, row: T): T & { [SHAPE_KEY]: ShapeTag } {
  return { ...row, [SHAPE_KEY]: shape };
}

/** Return a deep COPY of `value` with every `~`-prefixed meta key removed — used by json
 *  mode so the agent's machine-composition payload never carries render-only tags. A copy,
 *  not a mutation: the sql projector / handle / other readers still see the tagged data
 *  (§19). Non-meta key order is preserved (the tag was appended last), so a stripped json
 *  object is byte-identical to the pre-tag shape. */
export function stripShapeTags(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map(stripShapeTags);
  if (typeof value === 'object' && value !== null) {
    const out: Record<string, JsonValue> = {};
    for (const [key, child] of Object.entries(value)) {
      if (key.startsWith('~')) continue;
      out[key] = stripShapeTags(child);
    }
    return out;
  }
  return value;
}
