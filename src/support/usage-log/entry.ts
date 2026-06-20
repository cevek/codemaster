// One usage-log record — what an agent asked and what it got back (spec usage-telemetry).
// Written one-per-line as JSON to `success.jsonl` / `fail.jsonl` for later analysis of how
// the tool is actually used. The shape is the analysis contract; keep fields stable.

import type { JsonValue } from '../../core/json.ts';

export interface UsageLogEntry {
  /** Epoch ms when the call started (stamped via the injected Clock — §16 determinism). */
  ts: number;
  /** Wall-clock the call took, start→response. */
  durationMs: number;
  /** Which MCP tool was invoked (`op`/`status`/`batch`, or a verbatim unknown name). */
  tool: string;
  /** The op name(s) involved: one for `op`, the batch's names for `batch`, empty for `status`. */
  ops: string[];
  /** True when the call fully succeeded — no dispatch error, no `ToolFailure`, no bad args.
   *  Routes the entry to `success.jsonl` (true) or `fail.jsonl` (false). */
  ok: boolean;
  /** Client working directory the call resolved against. */
  cwd: string;
  /** The raw tool arguments the agent sent (the request). */
  args: JsonValue;
  /** The rendered response text the agent received (the answer). */
  response: string;
  /** Whether the response was flagged as an MCP error (dispatch/transport-level). */
  isError: boolean;
}

/** Routes a record to the success or fail sink. A no-op impl (telemetry disabled) and a
 *  file-backed impl both satisfy it; the MCP facade depends only on this. */
export interface UsageLogger {
  record(entry: UsageLogEntry): void;
  dispose(): void;
}
