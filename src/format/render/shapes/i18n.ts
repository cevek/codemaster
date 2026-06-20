// Renderers for the i18n row shapes (find_unused_i18n_keys / i18n_lookup /
// find_missing_i18n_keys). The condensed span already carries file:line:col, so the separate
// `file` key is dropped. All collapse at full too — a locale span is a location, not a proof
// body, and a list of keys never benefits from verbatim span objects.

import type { ShapeRenderer } from './types.ts';
import { confTail, flat, spanLoc } from './helpers.ts';

/** UnusedKeyView: { key, file, span, confidence }. */
export const i18nUnusedKey: ShapeRenderer = (v) =>
  `${spanLoc(v['span'])} · ${String(v['key'])}${confTail(v['confidence'])}`;

/** i18n_lookup KeyDef: { key, locale, file, span, value }. Value FLATTENED (a multi-line
 *  locale value would split into orphan lines with no clickable anchor). */
export const i18nDef: ShapeRenderer = (v) =>
  `${spanLoc(v['span'])} · ${String(v['key'])} · ${String(v['locale'])}=${flat(v['value'])}`;

/** i18n_lookup usage site: { key, span, provenance } — how the callee resolved rides the tail.
 *  (The old `{key,span}` branch was dead: the producer always adds provenance, so it exploded.) */
export const i18nUsage: ShapeRenderer = (v) => {
  const prov = v['provenance'] !== undefined ? ` · ${String(v['provenance'])}` : '';
  return `${spanLoc(v['span'])} · ${String(v['key'])}${prov}`;
};

/** i18n_lookup missing-per-key: { key, missingLocales[] }. */
export const i18nMissingPerKey: ShapeRenderer = (v) => {
  const locs = Array.isArray(v['missingLocales']) ? v['missingLocales'].join(',') : '';
  return `${String(v['key'])} · missing in [${locs}]`;
};

/** find_missing usage site: { key, span, missingLocales[] } — one row per usage, locale list
 *  folded in (never a row per missing locale). */
export const i18nMissingUsage: ShapeRenderer = (v) => {
  const locs = Array.isArray(v['missingLocales']) ? v['missingLocales'].join(',') : '';
  return `${spanLoc(v['span'])} · ${String(v['key'])} · missing in [${locs}]`;
};
