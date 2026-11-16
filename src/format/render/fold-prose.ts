// Prose folding over a `Result` COPY (§12): every prose string the text renderer will print passes
// through one `ProseFold`, walked in render order (failure → data → disclosures → truncation) so the
// first occurrence a reader meets is the one left in full. Data that merely LOOKS like prose is never
// folded: span text (verbatim source — `source` over codemaster's own tree carries lesson literals),
// sql cells, and diff/body payloads.

import type { Result } from '../../core/result.ts';
import type { JsonValue } from '../../core/json.ts';
import { isSqlTableData } from './render-table.ts';

export type ProseFold = (s: string) => string;

export const identityFold: ProseFold = (s) => s;

const VERBATIM_KEYS: ReadonlySet<string> = new Set(['diff', 'body', 'rows']);

export function foldResult(result: Result<JsonValue>, fold: ProseFold): Result<JsonValue> {
  if (fold === identityFold) return result;
  if (!result.ok) {
    const failure = { ...result.failure, message: fold(result.failure.message) };
    const data = result.data === undefined ? undefined : foldData(result.data, fold);
    return { ...withEnvelope(result, fold), failure, ...(data !== undefined ? { data } : {}) };
  }
  const data = isSqlTableData(result.data) ? result.data : foldData(result.data, fold);
  const folded = { ...result, data };
  return {
    ...withEnvelope(folded, fold),
    ...(result.truncated !== undefined
      ? { truncated: { ...result.truncated, hint: fold(result.truncated.hint) } }
      : {}),
  };
}

function withEnvelope<R extends Result<JsonValue>>(result: R, fold: ProseFold): R {
  if (result.disclosures === undefined) return result;
  return { ...result, disclosures: result.disclosures.map((d) => ({ ...d, note: fold(d.note) })) };
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
