// The facade's handled-call value: the agent-facing response plus its telemetry classification.

import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { OpResult } from '../ops/contracts.ts';

/** `bareJson` tells the seam cap that the text payload is a single parseable JSON object (a
 *  `format:'json'` per-op response) — so an over-cap payload is REPLACED with a valid capped
 *  envelope rather than tail-truncated (which would corrupt the JSON); text responses
 *  (status/batch/sql-multi/text) tail-truncate with the `!! OUTPUT CAPPED` marker. */
export interface HandledCall {
  result: CallToolResult;
  ok: boolean;
  ops: string[];
  bareJson: boolean;
  /** Renders `result` again from the same op results — for a session fold that a cap undid. */
  rerender?: () => CallToolResult;
}

export function ok(result: CallToolResult, ops: string[] = []): HandledCall {
  return { result, ok: true, ops, bareJson: false };
}

export function fail(result: CallToolResult, ops: string[] = [], bareJson = false): HandledCall {
  return { result, ok: false, ops, bareJson };
}

/** Classify an op/batch response from its STRUCTURED results, not from `isError`: a
 *  `Result` with `ok:false` (a `ToolFailure` — "couldn't, fall back") renders through a
 *  plain `text()` with no `isError`, so an isError-only check would file it as success.
 *  The call is a success only when every constituent op succeeded. */
export function classify(
  result: CallToolResult,
  results: readonly OpResult[],
  ops: string[],
  bareJson = false,
): HandledCall {
  return { result, ok: results.every((r) => !('error' in r) && r.result.ok), ops, bareJson };
}

/** `classify` for a response rendered by `render`, which may be called again (session re-render). */
export function rendered(
  render: () => CallToolResult,
  results: readonly OpResult[],
  ops: string[],
  bareJson = false,
): HandledCall {
  return { ...classify(render(), results, ops, bareJson), rerender: render };
}

const MAX_FOLD_RERENDERS = 8;

/** Cap the response; when a cap cut the one full copy a session fold relied on, render again
 *  keeping a later copy. Bounded — every retry moves a kept index forward or unfolds a lesson. */
export function cappedWithRefolds(
  handled: HandledCall,
  folds: { retryFor(text: string): boolean; startAttempt(): void },
  cap: (r: CallToolResult) => CallToolResult,
): CallToolResult {
  let result = cap(handled.result);
  for (let i = 0; i < MAX_FOLD_RERENDERS && handled.rerender !== undefined; i++) {
    if (!folds.retryFor(responseText(result))) break;
    folds.startAttempt();
    result = cap(handled.rerender());
  }
  return result;
}

/** The text payload of a response, for the telemetry `response` field. */
export function responseText(result: CallToolResult): string {
  const first = result.content[0];
  return first !== undefined && first.type === 'text' ? first.text : '';
}

function mapText(result: CallToolResult, f: (text: string) => string): CallToolResult {
  const first = result.content[0];
  if (first === undefined || first.type !== 'text') return result;
  return { ...result, content: [{ type: 'text', text: f(first.text) }] };
}

export function text(body: string): CallToolResult {
  return { content: [{ type: 'text', text: body }] };
}

export function errorText(message: string): CallToolResult {
  return { content: [{ type: 'text', text: message }], isError: true };
}
