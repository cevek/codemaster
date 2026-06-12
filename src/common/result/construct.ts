// Constructors for the `Result<T>` envelope (core/result.ts). Three honest shapes:
// ok (complete data), fail (an internal tool failed — no data, never a guess), and
// partial (some data was produced before the failure; `failure.partial` marks it so the
// agent never mistakes it for a complete answer). ARCHITECTURE.md §3.6.

import type {
  FailureResult,
  FreshnessNote,
  OkResult,
  ToolFailure,
  Truncation,
} from '../../core/result.ts';
import type { HandleRebind } from '../../core/ids.ts';

/** Envelope fields shared by all constructors. */
export interface ResultExtras {
  handle?: HandleRebind;
  freshness?: FreshnessNote;
  debug?: string[];
}

export function ok<T>(data: T, extras?: ResultExtras & { truncated?: Truncation }): OkResult<T> {
  return { ok: true, data, ...extras };
}

export function fail<T = never>(failure: ToolFailure, extras?: ResultExtras): FailureResult<T> {
  return { ok: false, failure: { ...failure, partial: false }, ...extras };
}

/** A failure that still carries the data produced before the tool fell over.
 *  Always marked `failure.partial = true` — partial dressed as complete is a lie. */
export function partial<T>(
  data: T,
  failure: Omit<ToolFailure, 'partial'>,
  extras?: ResultExtras,
): FailureResult<T> {
  return { ok: false, data, failure: { ...failure, partial: true }, ...extras };
}

/** Shorthand for the most common failure shape: tool + message. */
function toolFailure(tool: string, message: string): ToolFailure {
  return { tool, message };
}

/** Wrap a thrown value into a `ToolFailure`-shaped `Result` — the one chokepoint that
 *  turns exceptions from external tools into honest envelopes (§3.6: never a crash,
 *  never a guess). */
export function failFromThrown<T = never>(tool: string, thrown: unknown): FailureResult<T> {
  return fail(toolFailure(tool, messageOfThrown(thrown)));
}

/** Render a thrown value as a message without losing non-Error throws. */
export function messageOfThrown(thrown: unknown): string {
  if (thrown instanceof Error) return thrown.message;
  return typeof thrown === 'string' ? thrown : (JSON.stringify(thrown) ?? 'unknown error');
}
