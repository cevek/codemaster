// The op dispatch contract — what the MCP facade and the daemon see when an agent calls
// `op({ name, args, ... })`. Each individual op (e.g. `find_usages`) lives in its own
// file and exports its own typed `Args`/`Data` shapes; this file defines only the
// type-erased dispatch envelope used at the boundary.
//
// See ARCHITECTURE.md §5-L3 for the layer, §11 for the MCP surface, §7 for the dry-run /
// apply contract on mutating ops.

import type { Result, Verbosity } from '../core/result.ts';
import type { JsonValue } from '../core/json.ts';

/** Output-shape modifiers carried alongside every op call. Op implementations honor what
 *  they can; unrecognized fields are ignored (forward-compatible). */
export interface OpFlags {
  /** Mutating ops only: `false` (default) → dry-run preview; `true` → apply writes. */
  apply?: boolean;
  /** Mutating ops only: omit the (potentially huge) unified `diff` from the envelope and return
   *  only the verdict (`mode`/`typecheck`/`captures`) + ONE merged `touched` list — each written
   *  file with its `+added/-removed` line counts, a moved-away/deleted source marked `(removed)`.
   *  (Replaces the bare `touched` + separate `diffstat`; non-summary keeps bare `touched` + `diff`.)
   *  For when the agent wants the safety verdict, not the bytes — re-run without the flag for the
   *  full diff. */
  summaryOnly?: boolean;
  /** Output density (§12). */
  verbosity?: Verbosity;
  /** Output mode. Default `text` (the dense formatter); `json` for machine composition. */
  format?: 'text' | 'json';
  /** Per-call debug trace inline in a delimited trailer (§13). Off by default — spending
   *  the *using* agent's tokens for the *building* agent's benefit is the wrong pocket. */
  debug?: boolean;
}

/** One op invocation crossing the MCP/IPC boundary. The `args` payload is op-private —
 *  the dispatcher routes to the op by `name`, the op validates `args` with its own zod
 *  schema. */
export interface OpRequest extends OpFlags {
  /** Op id (e.g. 'find_usages', 'rename_symbol'). The set of valid names is per-engine
   *  (depends on which plugins are active) and discovered via `status`. */
  name: string;
  /** Op-specific arguments. JSON-validated at the boundary by the op's schema. */
  args: JsonValue;
  /** SQL table alias for this request's tabular projection, used only under a `batch`/`op`
   *  carrying `sql` (§3). Validated `^[a-z_][a-z0-9_]{0,30}$`; defaults to `t` (single
   *  request) or `t0..tN`. Ignored when the call has no `sql`. */
  as?: string;
  /** Per-request workspace root (cross-repo §1): a sibling TS repo this one request
   *  targets. Resolution precedence — request `root` > tool-level `root` > client cwd.
   *  The orchestrator groups requests by resolved root and dispatches one sub-batch per
   *  engine; results return in original request order. Absent → the tool/cwd root. */
  root?: string;
}

/** Batch-level modifiers that are NOT per-request (§5–6). Present only on the `batch`
 *  tool (and the `op` sugar, which desugars to a batch of one). */
export interface BatchOptions {
  /** A single read-only SELECT run across the requests' aliased tabular projections in an
   *  ephemeral in-memory SQLite database that lives only for this call (§1). When present,
   *  only the SQL result returns unless `return: 'all'`. */
  sql?: string;
  /** `'sql'` (default when `sql` is present) → only the SQL result; `'all'` → the
   *  per-request results too (uncapped producers can be large — opt-in). */
  return?: 'sql' | 'all';
}

/** Dispatch-level failure shape. Distinct from `ToolFailure` (which lives inside
 *  `Result<T>` for internal-tool failures the op observed): this is for the dispatcher
 *  itself rejecting the request before it reached an op. Codemaster never throws an
 *  exception across the MCP boundary; the dispatcher surfaces structured failures here. */
export interface DispatchError {
  kind:
    | 'unknown_op' // `name` does not match any registered op
    | 'bad_args' // `args` failed the op's zod validation
    | 'op_threw' // the op implementation threw something unwrapped
    | 'unavailable'; // a required plugin is not loaded for this engine
  message: string;
}

/** One op result, tagged with the op name and indexable in batch position. The error
 *  arm marks a request the dispatcher rejected without sinking the rest of a batch
 *  (§11). For internal-tool failures observed *by* the op, see `Result.failure`
 *  (`ToolFailure`) inside the success arm. */
export type OpResult =
  | { name: string; result: Result<JsonValue> }
  | { name: string; error: DispatchError };

/** A batch — many op invocations in one round-trip. Results come back in input order.
 *  Each touched plugin's freshness is captured at batch entry so the whole batch sees a
 *  consistent per-plugin view (§11). The batch-level `Result` carries the aggregated
 *  freshness; per-op `Result`s still carry their own `handle` rebinds and truncation. */
export type Batch = (requests: readonly OpRequest[]) => Promise<Result<readonly OpResult[]>>;
