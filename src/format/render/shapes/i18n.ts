// Renderers for the i18n row shapes (find_unused_i18n_keys / i18n_lookup /
// find_missing_i18n_keys). The condensed span already carries file:line:col, so the separate
// `file` key is dropped. All collapse at full too — a locale span is a location, not a proof
// body, and a list of keys never benefits from verbatim span objects.

import type { JsonValue } from '../../../core/json.ts';
import type { ShapeRenderer } from './types.ts';
import { confTail, flat, spanLoc } from './helpers.ts';
import { spanLocOnly, spanTextOf, unquote } from './span-text.ts';
import { HIDE_CONF_KEY, HIDE_MISSING_KEY } from './meta-keys.ts';

/** True when the span's proof text (normal/full) is the verbatim source token for `token` — a
 *  locale-JSON key (`"save"`) or a t() argument (`'a.b'`) — so the redundant sibling echo is
 *  dropped. Terse carries no text, so this is false and both stay. */
function spanEchoes(span: JsonValue | undefined, token: string): boolean {
  return unquote(spanTextOf(span)) === token;
}

const lastSegment = (key: string): string => key.split('.').at(-1) ?? key;

/** UnusedKeyView: { key, file, span, confidence }. The span's text is the locale-JSON key token
 *  (the key's last segment) — dropped to loc-only when it echoes (the dotted key is shown in full).
 *  `~hideConf` drops the per-row confidence tail when a global demote already states it. */
export const i18nUnusedKey: ShapeRenderer = (v) => {
  const key = String(v['key']);
  const loc = spanEchoes(v['span'], lastSegment(key)) ? spanLocOnly(v['span']) : spanLoc(v['span']);
  const conf = v[HIDE_CONF_KEY] === true ? '' : confTail(v['confidence']);
  return `${loc} · ${key}${conf}`;
};

/** i18n_lookup KeyDef: { key, locale, file, span, value }. Value FLATTENED (a multi-line locale
 *  value would split into orphan lines with no clickable anchor). The span text is the locale-JSON
 *  key token (the last segment) — dropped to loc-only when it echoes the full key shown next. */
export const i18nDef: ShapeRenderer = (v) => {
  const key = String(v['key']);
  const loc = spanEchoes(v['span'], lastSegment(key)) ? spanLocOnly(v['span']) : spanLoc(v['span']);
  return `${loc} · ${key} · ${String(v['locale'])}=${flat(v['value'])}`;
};

/** i18n_lookup usage site: { key, span, provenance }. The span text is the verbatim t() argument;
 *  when it echoes the full key the separate key is dropped (the span keeps the clickable proof). */
export const i18nUsage: ShapeRenderer = (v) => {
  const key = String(v['key']);
  const prov = v['provenance'] !== undefined ? ` · ${String(v['provenance'])}` : '';
  const keyPart = spanEchoes(v['span'], key) ? '' : ` · ${key}`;
  return `${spanLoc(v['span'])}${keyPart}${prov}`;
};

/** i18n_lookup missing-per-key: { key, missingLocales[] }. */
export const i18nMissingPerKey: ShapeRenderer = (v) => {
  const locs = Array.isArray(v['missingLocales']) ? v['missingLocales'].join(',') : '';
  return `${String(v['key'])} · missing in [${locs}]`;
};

/** find_missing usage site: { key, span, missingLocales[] } — one row per usage, locale list folded
 *  in. When the span text echoes the full key the separate key is dropped (span keeps the proof).
 *  `~hideMissing` drops the per-row `· missing in […]` when every row misses the same set (hoisted
 *  to a header note). */
export const i18nMissingUsage: ShapeRenderer = (v) => {
  const key = String(v['key']);
  const keyPart = spanEchoes(v['span'], key) ? '' : ` · ${key}`;
  const locs = Array.isArray(v['missingLocales']) ? v['missingLocales'].join(',') : '';
  const miss = v[HIDE_MISSING_KEY] === true ? '' : ` · missing in [${locs}]`;
  return `${spanLoc(v['span'])}${keyPart}${miss}`;
};
