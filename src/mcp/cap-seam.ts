// The MCP-seam total-size cap glue (§3.4/§12, t-287999): the CallToolResult-shaped wrapper around
// the pure `common/truncate/cap-response` logic. Kept out of server.ts so the facade stays under the
// file-size budget and the seam is unit-addressable. Bounds the SERIALIZED response frame — exactly
// what the harness measures (JSON-escaping is non-linear, so the raw text length is not a safe
// proxy) — and is a no-op (byte-identical) under the cap, so goldens/normal responses are untouched.

import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import {
  MCP_RESPONSE_MAX_BYTES,
  capMcpTextResponse,
  cappedJsonEnvelope,
} from '../common/truncate/cap-response.ts';

/** Replace a `CallToolResult`'s single text payload, preserving `isError`. */
function withText(result: CallToolResult, body: string): CallToolResult {
  return { ...result, content: [{ type: 'text', text: body }] };
}

/** The seam cap. `bareJson` = the payload is a single parseable JSON object (a `format:'json'`
 *  per-op response), so over-cap it is REPLACED with a valid capped envelope rather than
 *  tail-truncated (which would corrupt the JSON); text responses tail-truncate with the marker. */
export function capResponse(result: CallToolResult, bareJson: boolean): CallToolResult {
  const first = result.content[0];
  if (first === undefined || first.type !== 'text') return result;
  const body = first.text;
  const frame = (t: string): number =>
    Buffer.byteLength(JSON.stringify(withText(result, t)), 'utf8');
  if (frame(body) <= MCP_RESPONSE_MAX_BYTES) return result;
  if (bareJson) {
    const env = cappedJsonEnvelope(Buffer.byteLength(body, 'utf8'), MCP_RESPONSE_MAX_BYTES);
    return withText(result, env);
  }
  return withText(result, capMcpTextResponse(body, MCP_RESPONSE_MAX_BYTES, frame).text);
}
