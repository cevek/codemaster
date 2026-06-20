// Renderers for the scss / css_cascade / css co-extract row shapes. The condensed span
// carries file:line:col, so a separate `file` key is dropped. Tagged dispatch keeps the
// cascade winner and loser/co-winner apart explicitly — the old key-set match relied on
// branch ORDER (winner checked before the structurally-overlapping decl-ref).

import type { JsonValue } from '../../../core/json.ts';
import type { ShapeRenderer } from './types.ts';
import { asArray, confTail, flat, isObject } from './helpers.ts';

/** ScssClassView / UnusedClassView: { name, file, span, confidence, note? }. */
export const scssClass: ShapeRenderer = (v) => {
  const note = v['note'] !== undefined ? ` · ${String(v['note'])}` : '';
  return `${String(v['span'])} · ${String(v['name'])}${confTail(v['confidence'])}${note}`;
};

/** `[spec] span · selector = value [!important]` — the shared line for a cascade decl ref. */
function declRefLine(v: Record<string, JsonValue>): string {
  const imp = v['important'] === true ? ' !important' : '';
  return `[${String(v['specificity'])}] ${String(v['span'])} · ${String(v['selector'])} = ${flat(v['value'])}${imp}`;
}

/** `prop:value [!important]; …` for a rule's declaration list (plain {prop,value} objects). */
function declList(value: JsonValue | undefined): string {
  return asArray(value)
    .map((d) => {
      if (isObject(d)) {
        const imp = d['important'] === true ? ' !important' : '';
        return `${String(d['prop'])}:${flat(d['value'])}${imp}`;
      }
      return String(d);
    })
    .join('; ');
}

/** CascadeRuleView (a contributing rule) — `[spec] span · selector [flags] · {decls}`. */
export const cssRule: ShapeRenderer = (v) => {
  const flags: string[] = [];
  if (v['crossModule'] === true) flags.push('cross-module');
  if (v['global'] === true) flags.push(':global');
  if (v['interpolated'] === true) flags.push('interpolated');
  for (const c of asArray(v['conditions'])) flags.push(String(c));
  for (const a of asArray(v['atContext'])) flags.push(String(a));
  const extra = asArray(v['requiresExtraClasses']);
  const extraStr = extra.length > 0 ? ` +.${extra.join('.')}` : '';
  const flagStr = flags.length > 0 ? ` · ${flags.join(',')}` : '';
  return `[${String(v['specificity'])}] ${String(v['span'])} · ${String(v['selector'])}${extraStr}${flagStr} · {${declList(v['declarations'])}}`;
};

/** CascadeProperty (the per-property verdict) — `prop: <winner>` + indented losers. */
export const cssProperty: ShapeRenderer = (v) => {
  const losers = asArray(v['losers']);
  const tail = losers.length > 0 ? `\n    loses: ${losers.map(String).join(' | ')}` : '';
  return `${String(v['prop'])}: ${String(v['winner'])}${tail}`;
};

/** CascadeWinner (winning declaration) — the verdict line + confidence/reason/ambiguity. */
export const cssWinner: ShapeRenderer = (v) => {
  const note = v['note'] !== undefined ? ` · ${flat(v['note'])}` : '';
  const amb = asArray(v['ambiguousWith']);
  const ambStr = amb.length > 0 ? ` · ambiguous-with: ${amb.map(String).join(' | ')}` : '';
  return `${declRefLine(v)}${confTail(v['confidence'])}${note}${ambStr}`;
};

/** CascadeDeclRef (a loser / co-winner) — `[spec] span · selector = value`. */
export const cssDeclRef: ShapeRenderer = (v) => declRefLine(v);

/** LeftBehindEntry (extract_symbol cssCoExtract.leftBehind) — { class, code, reason, detail?,
 *  span? }. */
export const cssLeftBehind: ShapeRenderer = (v) => {
  const loc = v['span'] !== undefined ? `${String(v['span'])} · ` : '';
  const detail = v['detail'] !== undefined ? ` — ${flat(v['detail'])}` : '';
  return `${loc}${String(v['class'])} · ${String(v['code'])} · ${flat(v['reason'])}${detail}`;
};

/** CssCoExtractReport — { sourceStylesheet, targetStylesheet, moved[], leftBehind[], note? }.
 *  One header line; the (already-condensed) left-behind rows ride beneath only when non-empty —
 *  an empty `leftBehind (0):` is dropped. */
export const cssCoExtract: ShapeRenderer = (v) => {
  const target =
    typeof v['targetStylesheet'] === 'string' && v['targetStylesheet'].length > 0
      ? ` → ${v['targetStylesheet']}`
      : '';
  const moved = asArray(v['moved']).map(String);
  const movedStr = moved.length > 0 ? ` · moved [${moved.join(',')}]` : ' · moved nothing';
  const note = v['note'] !== undefined ? ` · ${flat(v['note'])}` : '';
  const head = `${String(v['sourceStylesheet'])}${target}${movedStr}${note}`;
  const left = asArray(v['leftBehind']).map(String);
  if (left.length === 0) return head;
  const indented = left.map((l) => `  left: ${l}`).join('\n');
  return `${head}\n${indented}`;
};
