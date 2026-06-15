// Verbosity-driven span condensation (§12). The tool must return an ANSWER, not
// material for one: by default a span renders as a clickable `file:line:col` —
// verbatim proof text is opt-in (`full`), because for list-shaped answers it is 90%
// of the tokens and 0% of the signal. The agent can always re-fetch one symbol's
// proof via find_definition/expand_type with verbosity=full.
//
//   terse  → "file:line:col"
//   normal → "file:line:col · first line of the span text (≤60ch)"
//   full   → the span object untouched (verbatim proof text)

import type { JsonValue } from '../../core/json.ts';
import type { Verbosity } from '../../core/result.ts';

const NORMAL_TEXT_CAP = 60;

export function condenseSpans(value: JsonValue, verbosity: Verbosity): JsonValue {
  if (verbosity === 'full') return value;
  if (isJsonArray(value)) return value.map((v) => condenseSpans(v, verbosity));
  if (typeof value === 'object' && value !== null) {
    const v = value as Record<string, JsonValue>;
    if (looksLikeSpan(v)) return renderSpanLine(v, verbosity);
    const out: Record<string, JsonValue> = {};
    for (const [key, child] of Object.entries(v)) out[key] = condenseSpans(child, verbosity);
    // Collapse one-fact rows at terse AND normal (full returned above). At normal the condensed
    // spans already carry their first-line text, so the same collapse yields a richer one-liner —
    // a `normal` list answer is compact lines, not multi-line key=value blocks.
    return collapseKnownShape(out);
  }
  return value;
}

/** Well-known one-fact objects collapse to ONE line — the id already carries name +
 *  file:line:col, so `{id,name,kind,span}` as keyed fields is pure repetition. Runs at terse
 *  AND normal; at normal the condensed spans carry their first-line text, so the same collapse
 *  yields a richer line (+ the decl header for a SymbolView). Unknown shapes pass through. */
function collapseKnownShape(v: Record<string, JsonValue>): JsonValue {
  const keys = Object.keys(v).sort().join(',');
  // SymbolView: { id, name, kind, span(condensed), decl?(condensed), container? }. The id already
  // carries name + file:line:col, and `span` is the name-token (text === name) — both redundant,
  // dropped. `decl` condenses to a bare `loc` at terse (→ no header) and `loc · <first line>` at
  // normal — pull that header onto a continuation line (never the redundant loc again).
  if (
    keys === 'id,kind,name,span' ||
    keys === 'container,id,kind,name,span' ||
    keys === 'decl,id,kind,name,span' ||
    keys === 'container,decl,id,kind,name,span'
  ) {
    const container = v['container'] !== undefined ? ` in ${String(v['container'])}` : '';
    const declStr = v['decl'] !== undefined ? String(v['decl']) : '';
    const sep = declStr.indexOf(' · ');
    const header = sep >= 0 ? `\n  ${declStr.slice(sep + 3)}` : '';
    return `${String(v['id'])} · ${String(v['kind'])}${container}${header}`;
  }
  // UsageView: { span(condensed), role, confidence }
  if (keys === 'confidence,role,span') {
    const confidence = v['confidence'] === 'certain' ? '' : ` · ${String(v['confidence'])}`;
    return `${String(v['span'])} · ${String(v['role'])}${confidence}`;
  }
  // Text-only hit (§ text-overlay): { span(condensed), confidence:'unresolved' } — no role,
  // because role is an AST concept the text scanner can't claim.
  if (keys === 'confidence,span') {
    return `${String(v['span'])} · ${String(v['confidence'])}`;
  }
  // GroupRow (enclosing rollup): { id, name, file, line, col, kind, count, roles,
  // exported, confidence } — the id already carries name + file:line:col, so terse
  // collapses to one line; the explicit columns exist for relational projection (§3).
  if (keys === 'col,confidence,count,exported,file,id,kind,line,name,roles') {
    const conf = v['confidence'] === 'certain' ? '' : ` · ${String(v['confidence'])}`;
    const exp = v['exported'] === true ? ' · exported' : '';
    return `${String(v['id'])} · ${String(v['kind'])} · x${String(v['count'])} (${String(v['roles'])})${exp}${conf}`;
  }
  // ImporterRow: { at, imports }
  if (keys === 'at,imports') {
    return `${String(v['at'])} · ${String(v['imports'])}`;
  }
  // ScssClassView: { name, file, span(condensed), confidence } and UnusedClassView (+ note?).
  // The condensed span already carries file:line:col, so the separate `file` key is pure
  // repetition — drop it. certain confidence is the default and stays implicit (like UsageView).
  if (keys === 'confidence,file,name,span' || keys === 'confidence,file,name,note,span') {
    const conf = v['confidence'] === 'certain' ? '' : ` · ${String(v['confidence'])}`;
    const note = v['note'] !== undefined ? ` · ${String(v['note'])}` : '';
    return `${String(v['span'])} · ${String(v['name'])}${conf}${note}`;
  }
  // UnusedKeyView (i18n): { key, file, span(condensed), confidence }. The condensed span carries
  // file:line:col, so the separate `file` is dropped; `certain` stays implicit. The demote reason
  // is global (stated once as the envelope's degradedReason), never repeated per row.
  if (keys === 'confidence,file,key,span') {
    const conf = v['confidence'] === 'certain' ? '' : ` · ${String(v['confidence'])}`;
    return `${String(v['span'])} · ${String(v['key'])}${conf}`;
  }
  // i18n_lookup KeyDef: { key, locale, file, span(condensed), value }. Drop the redundant
  // `file` (the condensed span carries it). The value is FLATTENED (newlines/tabs → one space):
  // a multi-line locale value would otherwise split into orphan lines with no clickable anchor.
  if (keys === 'file,key,locale,span,value') {
    const value = String(v['value']).replace(/\s+/g, ' ');
    return `${String(v['span'])} · ${String(v['key'])} · ${String(v['locale'])}=${value}`;
  }
  // i18n_lookup usage site: { key, span(condensed) }.
  if (keys === 'key,span') {
    return `${String(v['span'])} · ${String(v['key'])}`;
  }
  // i18n_lookup missing-per-key: { key, missingLocales[] }.
  if (keys === 'key,missingLocales') {
    const locs = Array.isArray(v['missingLocales']) ? v['missingLocales'].join(',') : '';
    return `${String(v['key'])} · missing in [${locs}]`;
  }
  // find_missing usage site: { key, span(condensed), missingLocales[] } — one row per usage,
  // the locale list folded in (never a row per missing locale).
  if (keys === 'key,missingLocales,span') {
    const locs = Array.isArray(v['missingLocales']) ? v['missingLocales'].join(',') : '';
    return `${String(v['span'])} · ${String(v['key'])} · missing in [${locs}]`;
  }
  // A bare single-span object (e.g. find_missing `dynamicUsages: {span}[]`): the `span=` key is
  // noise — render just the clickable location.
  if (keys === 'span') {
    return String(v['span']);
  }
  // MemberView (leaf — no nested `members`): { name, optional, type, inherited? }. A union type
  // carries spaces so it never inlines as k=v; render it as the familiar `name[?]: type` instead
  // of three keyed lines. A member WITH nested members keeps the structured form (falls through).
  if (keys === 'name,optional,type' || keys === 'inherited,name,optional,type') {
    const opt = v['optional'] === true ? '?' : '';
    const inh = v['inherited'] === true ? ' (inherited)' : '';
    return `${String(v['name'])}${opt}: ${String(v['type'])}${inh}`;
  }
  return v;
}

function renderSpanLine(span: Record<string, JsonValue>, verbosity: Verbosity): string {
  const loc = `${String(span['file'])}:${String(span['line'])}:${String(span['col'])}`;
  if (verbosity === 'terse') return loc;
  const firstLine = String(span['text']).split('\n')[0] ?? '';
  const text =
    firstLine.length > NORMAL_TEXT_CAP ? `${firstLine.slice(0, NORMAL_TEXT_CAP)}…` : firstLine;
  return text.length > 0 ? `${loc} · ${text}` : loc;
}

function looksLikeSpan(v: Record<string, JsonValue>): boolean {
  return (
    typeof v['file'] === 'string' &&
    typeof v['line'] === 'number' &&
    typeof v['col'] === 'number' &&
    typeof v['endLine'] === 'number' &&
    typeof v['text'] === 'string'
  );
}

function isJsonArray(value: JsonValue): value is readonly JsonValue[] {
  return Array.isArray(value);
}
