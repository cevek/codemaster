// Prose folding over a `Result` COPY (§12): every prose string the text renderer will print passes
// through one `ProseFold`, walked in render order (failure → data → truncation) so the
// first occurrence a reader meets is the one left in full. Data that merely LOOKS like prose is never
// folded: span text (verbatim source — `source` over codemaster's own tree carries lesson literals),
// sql cells, and diff/body payloads.

import type { Result } from '../../core/result.ts';
import type { JsonValue } from '../../core/json.ts';

export type ProseFold = (s: string) => string;

export const identityFold: ProseFold = (s) => s;

/** `rows` = sql table cells (data, whatever they look like); `diff`/`body` = source text. */
const VERBATIM_KEYS: ReadonlySet<string> = new Set(['diff', 'body', 'rows']);

/** Folds the failure message, the data and the truncation hint. Disclosures are folded as RENDERED
 *  lines instead (render-result): entries sharing one note collapse to a single line there, and
 *  folding them entry by entry first would split that group. */
export function foldResult(result: Result<JsonValue>, fold: ProseFold): Result<JsonValue> {
  if (fold === identityFold) return result;
  if (!result.ok) {
    const failure = { ...result.failure, message: fold(result.failure.message) };
    const data = result.data === undefined ? undefined : foldData(result.data, fold);
    return { ...result, failure, ...(data !== undefined ? { data } : {}) };
  }
  const data = foldData(result.data, fold);
  const truncated =
    result.truncated === undefined
      ? {}
      : { truncated: { ...result.truncated, hint: fold(result.truncated.hint) } };
  return { ...result, data, ...truncated };
}

function foldData(value: JsonValue, fold: ProseFold): JsonValue {
  if (typeof value === 'string') return fold(value);
  if (Array.isArray(value)) return (value as readonly JsonValue[]).map((v) => foldData(v, fold));
  if (value === null || typeof value !== 'object') return value;
  return foldObject(value as { readonly [key: string]: JsonValue }, fold);
}

function foldObject(value: { readonly [key: string]: JsonValue }, fold: ProseFold): JsonValue {
  const spanLike = typeof value['file'] === 'string' && typeof value['text'] === 'string';
  const out: { [k: string]: JsonValue } = {};
  for (const [k, v] of Object.entries(value)) {
    out[k] = (spanLike && k === 'text') || VERBATIM_KEYS.has(k) ? v : foldData(v, fold);
  }
  return out;
}
