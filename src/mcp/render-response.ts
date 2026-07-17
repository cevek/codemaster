// Rendering helpers for the MCP facade: turn an `OpResult` (or a list of them, or a batch) into the
// dense text / json payload. Split out of server.ts to keep the facade under the file-size budget;
// the seam cap (cap-seam.ts) then bounds whatever these produce.

import type { OpResult } from '../ops/contracts.ts';
import { renderResult, renderResultJson } from '../format/render/render-result.ts';
import { MCP_RESPONSE_MAX_BYTES, cappedJsonEnvelope } from '../common/truncate/cap-response.ts';
import { dispatchErrorLine } from './render-dispatch-error.ts';

/** Byte budget for a multi-section aggregate (batch / sql return:'all'). Below
 *  `MCP_RESPONSE_MAX_BYTES` with headroom for the section framing + JSON-escaping inflation, so the
 *  aggregate stays under the seam cap and the seam never has to blind-chop a batch (which would drop
 *  a surviving section's honesty tail). Each per-op section is already self-capped by
 *  `assembleEnvelope` (text) — this bounds their SUM, cutting only at whole-section boundaries. */
const AGGREGATE_BYTE_BUDGET = MCP_RESPONSE_MAX_BYTES - 15_000;

/** Render one aggregate section body, replacing an over-budget bare-`json` producer with a valid
 *  capped envelope (the multi-section analogue of the single-op bareJson seam path). Without this a
 *  lone json section larger than a whole section budget would reach the flat seam and be MID-chopped
 *  into corrupt, unparseable JSON (`renderResultJson` is intentionally uncapped). A text section is
 *  already self-capped by `assembleEnvelope`, so it passes through untouched. */
function sectionBody(
  r: OpResult,
  format: 'text' | 'json' | undefined,
  verbosity: 'terse' | 'normal' | 'full' | undefined,
): string {
  const body = renderOne(r, format, verbosity);
  if (format === 'json' && Buffer.byteLength(body, 'utf8') > AGGREGATE_BYTE_BUDGET) {
    return cappedJsonEnvelope(Buffer.byteLength(body, 'utf8'), AGGREGATE_BYTE_BUDGET);
  }
  return body;
}

/** Join `[i] name` sections under a byte budget, cutting only at WHOLE-section boundaries so every
 *  section that survives is complete WITH its own honesty tail (§12 / t-287999) — never a mid-section
 *  cut that drops a `freshness`/`truncation` channel. The first section is always kept (a lone
 *  over-budget section is then bounded by the MCP seam backstop); omitted sections are disclosed. */
function joinSectionsCapped(sections: readonly string[]): string {
  const kept: string[] = [];
  let bytes = 0;
  for (let i = 0; i < sections.length; i++) {
    const s = sections[i] ?? '';
    const add = (kept.length > 0 ? 2 : 0) + Buffer.byteLength(s, 'utf8');
    if (kept.length > 0 && bytes + add > AGGREGATE_BYTE_BUDGET) {
      kept.push(
        `!! OUTPUT CAPPED — ${sections.length - i} more section(s) omitted to stay under the size ceiling; re-run them individually or narrow each. Sections shown are complete.`,
      );
      break;
    }
    kept.push(s);
    bytes += add;
  }
  return kept.join('\n\n');
}

export type ReqFlags = {
  format?: 'text' | 'json' | undefined;
  verbosity?: 'terse' | 'normal' | 'full' | undefined;
};
type BatchFlags = { sqlPresent: boolean } & ReqFlags;

/** Render one op result: a dispatch error → its dense line (or json envelope); a success → the
 *  dense/json render of its envelope. */
export function renderOne(
  result: OpResult,
  format: 'text' | 'json' | undefined,
  verbosity: 'terse' | 'normal' | 'full' | undefined,
): string {
  if ('error' in result) return dispatchErrorLine(result.error, format);
  if (format === 'json') return renderResultJson(result.result);
  return renderResult(result.result, verbosity ?? 'terse');
}

/** Render one-or-more op results (the op-sql sugar yields 1 with return:'sql', or N+1
 *  with return:'all'). A single result renders bare; several get `[i] name` headers. */
export function renderResults(
  results: readonly OpResult[],
  format: 'text' | 'json' | undefined,
  verbosity: 'terse' | 'normal' | 'full' | undefined,
): string {
  if (results.length === 1 && results[0] !== undefined) {
    return renderOne(results[0], format, verbosity);
  }
  return joinSectionsCapped(
    results.map((r, i) => `[${i}] ${r.name}\n${sectionBody(r, format, verbosity)}`),
  );
}

/** Render a batch's ordered results. The synthetic `sql` result (the join output) renders
 *  with the BATCH-level `format`/`verbosity` — the per-request flags belong to the
 *  producers, not the join. Exported so the flag routing is unit-tested. */
export function renderBatch(
  results: readonly OpResult[],
  requests: readonly ReqFlags[],
  batch: BatchFlags,
): string {
  return joinSectionsCapped(
    results.map((r, i) => {
      const isSqlResult = batch.sqlPresent && r.name === 'sql';
      const format = isSqlResult ? batch.format : requests[i]?.format;
      const verbosity = isSqlResult ? batch.verbosity : requests[i]?.verbosity;
      return `[${i}] ${r.name}\n${sectionBody(r, format, verbosity)}`;
    }),
  );
}
