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
    return verbosity === 'terse' ? collapseKnownShape(out) : out;
  }
  return value;
}

/** In terse mode, well-known one-fact objects collapse to ONE line — the id already
 *  carries name + file:line:col, so `{id,name,kind,span}` as four keyed fields is
 *  pure repetition. Unknown shapes pass through untouched. */
function collapseKnownShape(v: Record<string, JsonValue>): JsonValue {
  const keys = Object.keys(v).sort().join(',');
  // SymbolView: { id, name, kind, span(condensed), decl?(condensed), container? }. Terse is
  // location-only, so the full `decl` span (§3.1) collapses away with the rest — the id
  // already carries name + file:line:col. decl text surfaces at normal/full.
  if (
    keys === 'id,kind,name,span' ||
    keys === 'container,id,kind,name,span' ||
    keys === 'decl,id,kind,name,span' ||
    keys === 'container,decl,id,kind,name,span'
  ) {
    const container = v['container'] !== undefined ? ` in ${String(v['container'])}` : '';
    return `${String(v['id'])} · ${String(v['kind'])}${container}`;
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
