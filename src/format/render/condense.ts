// Verbosity-driven condensation (§12). The tool must return an ANSWER, not material for one:
// by default a span renders as a clickable `file:line:col` — verbatim proof text is opt-in
// (`full`), because for list-shaped answers it is 90% of the tokens and 0% of the signal.
//
//   terse  → "file:line:col"
//   normal → "file:line:col · first line of the span text (≤60ch)"
//   full   → the span object untouched (verbatim proof text)
//
// Beyond spans, every renderable ROW carries a `~shape` tag (common/shape-tag), and this
// dispatches tag → renderer (format/render/shapes). The dispatch is BOTTOM-UP: a row's child
// spans and nested tagged rows are condensed first, then the row's own renderer runs over the
// already-condensed children. An unknown tag fails LOUD (a `~shape=` marker the coverage guard
// catches), never a silent fall-through into render-dense's multi-line key=value exploder.

import type { JsonValue } from '../../core/json.ts';
import type { Verbosity } from '../../core/result.ts';
import { SHAPE_KEY, type ShapeTag } from '../../common/shape-tag/tag.ts';
import { COLLAPSE_AT_FULL, SHAPE_RENDERERS } from './shapes/index.ts';

const NORMAL_TEXT_CAP = 60;

export { summarizeQueryKey } from './shapes/helpers.ts';

export function condenseSpans(value: JsonValue, verbosity: Verbosity): JsonValue {
  if (isJsonArray(value)) return value.map((v) => condenseSpans(v, verbosity));
  if (isObject(value)) {
    // A raw span renders verbatim at full (the whole point of full); a clickable line otherwise.
    if (looksLikeSpan(value))
      return verbosity === 'full' ? value : renderSpanLine(value, verbosity);
    // Bottom-up: condense children first, so nested spans / tagged rows are already collapsed
    // when this object's renderer runs.
    const out: Record<string, JsonValue> = {};
    for (const [key, child] of Object.entries(value)) out[key] = condenseSpans(child, verbosity);
    const tagVal = out[SHAPE_KEY];
    if (typeof tagVal === 'string') {
      // At full, a proof-bearing row passes through verbatim (the pre-tag behavior); only the
      // non-proof structural forms collapse (members/spans/list rows carry no verbatim body).
      if (verbosity === 'full' && !COLLAPSE_AT_FULL.has(tagVal as ShapeTag)) {
        // The renderer does NOT run here to consume them, so strip EVERY `~`-meta key — the
        // shape tag AND render-only hints (~subject/~sectioned/…) — so none reaches render-dense
        // as a `~key=value` field. (Recursion already condensed nested rows, which stripped
        // their own.) META keys are never rendered, on this branch or the renderer branch.
        for (const k of Object.keys(out)) if (k.startsWith('~')) delete out[k];
        return out;
      }
      delete out[SHAPE_KEY]; // META — stripped before the renderer (which reads other `~`-hints).
      const renderer = SHAPE_RENDERERS[tagVal as ShapeTag];
      // Unrecognized tag — LOUD, never a silent explode. The `~shape=` token trips the coverage
      // guard. (Compile-time `Record<ShapeTag,…>` makes this practically unreachable.)
      if (renderer === undefined) return `!! no renderer for ${SHAPE_KEY}=${tagVal}`;
      return renderer(out, verbosity);
    }
    // Untagged: an envelope / legit map (root data object, `scanned`, `summary`, …) — render as is.
    return out;
  }
  return value;
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

function isObject(value: JsonValue): value is Record<string, JsonValue> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
