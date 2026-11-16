// The facade's handled-call value: the agent-facing response plus its telemetry classification.

import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { OpResult } from '../ops/contracts.ts';
import { exampleCallFor } from './schema.ts';

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

export const MAX_FOLD_RERENDERS = 8;

/** Cap the response; when a cap cut the one full copy a session fold relied on, render again
 *  keeping a later copy. Past `maxRerenders` the response renders with no fold at all, so a fold
 *  never reaches the reader without its full text. */
export function cappedWithRefolds(
  handled: HandledCall,
  folds: { retryFor(text: string): boolean; startAttempt(): void; unfoldAll(): void },
  cap: (r: CallToolResult) => CallToolResult,
  maxRerenders: number = MAX_FOLD_RERENDERS,
): CallToolResult {
  let result = cap(handled.result);
  const rerender = handled.rerender;
  if (rerender === undefined) return result;
  for (let i = 0; folds.retryFor(responseText(result)); i++) {
    if (i >= maxRerenders) folds.unfoldAll();
    folds.startAttempt();
    result = cap(rerender());
    if (i >= maxRerenders) break;
  }
  return result;
}

/** The text payload of a response, for the telemetry `response` field. */
export function responseText(result: CallToolResult): string {
  const first = result.content[0];
  return first !== undefined && first.type === 'text' ? first.text : '';
}

/** A validation rejection that also teaches the fix: the zod message plus a minimal
 *  valid arguments object for the tool (§1.2, §7 "agents author blind; pointed errors").
 *  The example alone is enough to author the corrected call. */
export function badArgs(tool: 'status' | 'batch', message: string): CallToolResult {
  const example = exampleCallFor(tool);
  const valid = example === undefined ? '' : ` — valid: ${JSON.stringify(example)}`;
  return errorText(`bad args: ${message}${valid}`);
}

export function text(body: string): CallToolResult {
  return { content: [{ type: 'text', text: body }] };
}

export function errorText(message: string): CallToolResult {
  return { content: [{ type: 'text', text: message }], isError: true };
}
