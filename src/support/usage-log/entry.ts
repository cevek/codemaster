// One usage-log record — what an agent asked and what it got back (spec usage-telemetry).
// Written one-per-line as JSON to `success.jsonl` / `fail.jsonl` for later analysis of how
// the tool is actually used. The shape is the analysis contract; keep fields stable.

import type { JsonValue } from '../../core/json.ts';

export interface UsageLogEntry {
  /** Epoch ms when the call started (stamped via the injected Clock — §16 determinism). */
  ts: number;
  /** Wall-clock the call took, start→response. `null` ONLY on an `outcome:'crash'` record: the
   *  process died with the call in flight, so the moment of death is unknown and any number here
   *  would be fabricated. */
  durationMs: number | null;
  /** Which MCP tool was invoked (an op name / `status` / `batch`, or a verbatim unknown name). */
  tool: string;
  /** The op name(s) involved: the op name for a per-op call, the batch's names for `batch`, empty for `status`. */
  ops: string[];
  /** True when the call fully succeeded — no dispatch error, no `ToolFailure`, no bad args.
   *  Routes the entry to `success.jsonl` (true) or `fail.jsonl` (false). */
  ok: boolean;
  /** Client working directory the call resolved against. */
  cwd: string;
  /** The raw tool arguments the agent sent (the request). On an `origin:'daemon'` record this is
   *  instead the WIRE request list (`[{name, args}]`) — the daemon never sees the flat tool args —
   *  so a consumer parsing it as a single argument object must branch on `origin`. */
  args: JsonValue;
  /** The rendered response text the agent received (the answer). */
  response: string;
  /** Whether the response was flagged as an MCP error (dispatch/transport-level). */
  isError: boolean;
  /** Present ONLY on a record materialized from an orphaned in-flight breadcrumb — there is no
   *  response and no duration. `crash`: the owning process is gone, so the call provably died with
   *  it. `abandoned`: the owner still answers, so death is NOT proven — the call was merely left in
   *  flight far too long (a wedge, or a recycled pid). Absent on every ordinary record, so an
   *  existing consumer's key-set is unchanged. */
  outcome?: 'crash' | 'abandoned';
  /** Which process's VIEW this is. Absent = the agent-facing serving process (bridge /
   *  `--in-process` / fallback), the sole owner of call ACCOUNTING — every ordinary record is one of
   *  these. `'daemon'` marks a record promoted from a breadcrumb the singleton daemon left in
   *  flight: `outcome:'crash'` when its pid is gone, `'abandoned'` when it still answers.
   *
   *  COUNTING: the daemon writes no ordinary record, so there is never a second ACCOUNTING record —
   *  but a fatal call still yields TWO lines in `fail.jsonl` (the agent-facing process's ordinary
   *  `ok:false`, and this view of the same call). Count calls by filtering `origin === undefined`;
   *  correlate the pair on `cwd` + `ops`. Additive like `outcome` — absent on every ordinary record,
   *  so an existing consumer's key-set is unchanged. */
  origin?: 'daemon';
}

/** The pre-dispatch breadcrumb: what a call was, stamped to disk BEFORE it runs so a fatal
 *  (in-process OOM, SIGKILL) still leaves a trace. Cleared when the call returns. */
export interface InflightCall {
  /** Epoch ms when the call started (injected Clock — §16 determinism). */
  ts: number;
  /** The MCP tool invoked — the op name for a per-op call, `status` / `batch`. */
  tool: string;
  /** Best-effort op names (a batch's constituent ops), so a crash is attributed to an OP. */
  ops: string[];
  /** Client working directory — the first triage question is WHICH repo killed the process. */
  cwd: string;
  /** The raw tool arguments the agent sent. */
  args: JsonValue;
  /** Whose view this breadcrumb is — see `UsageLogEntry.origin`. Carried through the promotion so
   *  the recovered record says which process observed the call. */
  origin?: 'daemon';
}

/** Handle returned by `begin`: `clear()` removes the breadcrumb once the call has been recorded. */
export interface InflightHandle {
  clear(): void;
}

/** Routes a record to the success or fail sink. A no-op impl (telemetry disabled) and a
 *  file-backed impl both satisfy it; the MCP facade depends only on this.
 *
 *  `begin` is REQUIRED, not optional: a logger that silently skipped the breadcrumb would
 *  reintroduce the invisible-fatal hole this seam exists to close, so an incomplete impl must be a
 *  compile error. */
export interface UsageLogger {
  begin(call: InflightCall): InflightHandle;
  record(entry: UsageLogEntry): void;
  dispose(): void;
}
