// Serialize a dispatch-level rejection (§3 honesty, t-337633) for the agent-facing render surface.
// A DispatchError is the dispatcher rejecting a request BEFORE it reached an op (unknown_op /
// bad_args / op_threw / unavailable) — distinct from a Result's `failure` (a ToolFailure the op
// itself observed). The SINGLE shared serializer for every render site (mcp/server.ts renderOne +
// opResultText, and the CLI in bin.ts), so CLI↔MCP stay byte-parity with no parallel serializer.

import type { DispatchError } from '../ops/contracts.ts';

/** The `format:'json'` body: a valid, machine-parseable envelope so a `codemaster op … --format
 *  json | jq` consumer never meets non-JSON text on a dispatch error. `ok:false` mirrors a
 *  `renderResultJson` success (`ok:true`); the `dispatch` key carries the cause, recoverable via
 *  `jq .dispatch.kind` (distinct from a Result's `failure`). */
export function dispatchErrorJson(error: DispatchError): string {
  return JSON.stringify({ ok: false, dispatch: error });
}

/** The dispatch-error body honoring `format` for the DISPATCH-prefixed sites (renderOne, the CLI):
 *  valid JSON under json, else the dense `DISPATCH <kind>: <msg>` line. (opResultText's per-op text
 *  form carries no `DISPATCH` prefix and a staleness banner, so it composes `dispatchErrorJson`
 *  directly rather than through here.) */
export function dispatchErrorLine(
  error: DispatchError,
  format: 'text' | 'json' | undefined,
): string {
  return format === 'json' ? dispatchErrorJson(error) : `DISPATCH ${error.kind}: ${error.message}`;
}
