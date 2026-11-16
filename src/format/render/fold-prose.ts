// Prose folding over a `Result` COPY (§12): the explanation channels of an answer pass through one
// `ProseFold`, walked in render order (failure → data → truncation) so the first occurrence a reader
// meets is the one left in full. Only strings under a PROSE key fold: everything else is data — a
// type text, a JSX prop value, a span, an sql cell — which may equal a lesson by coincidence and
// must never be rewritten.

import type { Result } from '../../core/result.ts';
import type { JsonValue } from '../../core/json.ts';
import { SHAPE_KEY } from '../../common/shape-tag/tag.ts';

export type ProseFold = (s: string) => string;

export const identityFold: ProseFold = (s) => s;

/** The keys ops put explanations under (a string, or an array of strings, at any depth). */
const PROSE_KEYS: ReadonlySet<string> = new Set([
  'note',
  'notes',
  'surface',
  'scope',
  'notAVerdict',
  'hint',
  'reason',
  'redirect',
]);

/** Folds the failure message, the data and the truncation hint. Disclosures are folded as RENDERED
 *  lines instead (render-result): entries sharing one note collapse to a single line there, and
 *  folding them entry by entry first would split that group. */
export function foldResult(result: Result<JsonValue>, fold: ProseFold): Result<JsonValue> {
  if (fold === identityFold) return result;
  if (!result.ok) {
    const failure = { ...result.failure, message: fold(result.failure.message) };
    const data = result.data === undefined ? undefined : foldData(result.data, fold, false);
    return { ...result, failure, ...(data !== undefined ? { data } : {}) };
  }
  const data = foldData(result.data, fold, false);
  const truncated =
    result.truncated === undefined
      ? {}
      : { truncated: { ...result.truncated, hint: fold(result.truncated.hint) } };
  return { ...result, data, ...truncated };
}

function foldData(value: JsonValue, fold: ProseFold, prose: boolean): JsonValue {
  if (typeof value === 'string') return prose ? fold(value) : value;
  if (Array.isArray(value)) {
    return (value as readonly JsonValue[]).map((v) => foldData(v, fold, prose));
  }
  if (value === null || typeof value !== 'object') return value;
  const obj = value as { readonly [key: string]: JsonValue };
  // A trace hop's note quotes the source expression it walked through: proof text, not prose.
  if (obj[SHAPE_KEY] === 'trace-hop') return value;
  const out: { [k: string]: JsonValue } = {};
  for (const [k, v] of Object.entries(obj)) {
    out[k] = foldData(v, fold, PROSE_KEYS.has(k));
  }
  return out;
}
