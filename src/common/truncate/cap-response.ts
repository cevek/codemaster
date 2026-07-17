// The MCP-seam TOTAL-size cap (§3.4, §12, task t-287999): a UNIVERSAL backstop over the per-op
// §12 char-caps guaranteeing that NO MCP tool response can exceed the harness output ceiling. Above
// that ceiling the harness persists the response to a file and the agent sees only a ~2KB preview +
// a path — the answer is unreadable in place, which for `status` (the first-contact doc) or any
// large result defeats the tool.
//
// This module is PURE (common → core only): it caps a text body against the SERIALIZED response
// size, measured by a caller-supplied `frameBytes` closure so we bound exactly what the harness
// bounds (the full JSON-RPC frame, whose JSON-escaping is non-linear — a `"`/`\`-heavy body inflates
// on serialize), never a proxy like the raw text length. The MCP facade wires `frameBytes` to
// `Buffer.byteLength(JSON.stringify(callToolResult(body)))`.

/** The seam cap on the SERIALIZED response frame, in bytes (~5.5K under the observed ~65_536 = 64KiB
 *  harness ceiling — headroom for the JSON-RPC `{jsonrpc,id,result}` wrapper the SDK adds). One
 *  constant, used at the seam and asserted (against the REAL ceiling) by the size test matrix. */
export const MCP_RESPONSE_MAX_BYTES = 60_000;

/** The real harness ceiling — the size test matrix asserts every response frame stays under THIS,
 *  not just under our internal (more conservative) `MCP_RESPONSE_MAX_BYTES`. */
export const HARNESS_CEILING_BYTES = 65_536;

/** The honest text-path truncation marker (§3.4): its presence IS the signal that a cut happened,
 *  so it is ALWAYS appended when the body is trimmed — never a silent drop. Verdict-first (§12): the
 *  load-bearing head survives, only the re-fetchable tail is cut. */
export const CAP_MARKER =
  '!! OUTPUT CAPPED — response exceeded the harness size ceiling; the tail was dropped. Narrow the query, use verbosity:terse, or fetch one op via status {op:"<name>"} — do NOT assume this is everything.';

/** Extra bytes shaved per iteration so each pass makes real progress toward the cap (guards against
 *  a fixed point where the estimated cut lands exactly on the boundary). */
const SLACK_BYTES = 64;

/** A char-elided string plus whether the cut fired. */
export interface CappedText {
  text: string;
  capped: boolean;
}

/** Cut `s` to at most `maxBytes` UTF-8 bytes at a SAFE boundary: prefer the last newline in range
 *  (`\n` is a single byte, always a valid boundary and a clean line cut); else a raw byte cut backed
 *  off any UTF-8 continuation byte so a multi-byte rune is never split. Exported so the structured
 *  render layer (`assembleEnvelope`, the batch/sql aggregators) shares one UTF-8-safe byte cut. */
export function cutAtByteBoundary(s: string, maxBytes: number): string {
  const buf = Buffer.from(s, 'utf8');
  if (buf.length <= maxBytes) return s;
  const nl = buf.lastIndexOf(0x0a, maxBytes);
  if (nl > 0) return buf.toString('utf8', 0, nl);
  let end = maxBytes;
  // Back off while the byte at `end` (first excluded) is a continuation byte (0b10xxxxxx).
  while (end > 0 && ((buf[end] ?? 0) & 0xc0) === 0x80) end--;
  return buf.toString('utf8', 0, end);
}

/** Cap a TEXT response body so its SERIALIZED frame stays ≤ `maxBytes`. A no-op (byte-identical
 *  passthrough) when already under the cap — so goldens and every normal response are untouched.
 *  Over the cap: iteratively trim the tail and append `CAP_MARKER`, re-measuring the real frame each
 *  pass so convergence is GUARANTEED by construction (bounded iterations), not merely estimated. */
export function capMcpTextResponse(
  body: string,
  maxBytes: number,
  frameBytes: (body: string) => number,
): CappedText {
  if (frameBytes(body) <= maxBytes) return { text: body, capped: false };
  const markerFrameFloor = frameBytes(CAP_MARKER);
  // Degenerate guard: if even the bare marker's frame exceeds the cap (cannot happen with a 60K cap
  // and a ~200-byte marker, but keep the function total), return the marker alone.
  if (markerFrameFloor > maxBytes) return { text: CAP_MARKER, capped: true };
  let head = body;
  for (let i = 0; i < 8; i++) {
    const candidate = head.length > 0 ? `${head}\n${CAP_MARKER}` : CAP_MARKER;
    const over = frameBytes(candidate) - maxBytes;
    if (over <= 0) return { text: candidate, capped: true };
    const headBytes = Buffer.byteLength(head, 'utf8');
    const budget = Math.max(headBytes - over - SLACK_BYTES, 0);
    head = cutAtByteBoundary(head, budget);
  }
  // Bounded loop exhausted (pathological) — return the marker alone, still honest and under cap.
  return { text: CAP_MARKER, capped: true };
}

/** The bare-JSON over-cap replacement (§12): a valid, small JSON envelope. A `format:'json'` payload
 *  is a single parseable object, so a tail-cut would corrupt it — instead the whole payload is
 *  replaced with this honest, machine-readable capped signal (the json analogue of `CAP_MARKER`). */
export function cappedJsonEnvelope(actualBytes: number, maxBytes: number): string {
  return JSON.stringify({
    error: 'output_capped',
    limit: maxBytes,
    bytes: actualBytes,
    hint: 'response exceeded the harness size ceiling; re-run with verbosity:terse, narrow the query, or fetch one op via status {op:"<name>"}',
  });
}
