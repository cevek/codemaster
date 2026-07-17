// The MCP-seam total-size cap (§3.4/§12, t-287999): the pure logic behind the universal backstop
// guaranteeing no response frame exceeds the harness output ceiling. Oracle: the invariant itself —
// the SERIALIZED frame the harness measures must land under the cap, the honesty marker must be
// present on any cut, and a multi-byte body must never be split mid-rune. Fully deterministic.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MCP_RESPONSE_MAX_BYTES,
  HARNESS_CEILING_BYTES,
  CAP_MARKER,
  capMcpTextResponse,
  cappedJsonEnvelope,
} from '../../src/common/truncate/cap-response.ts';

/** Model the real frame the seam measures: the text wrapped in a `CallToolResult`, serialized. */
function frameOf(body: string): number {
  return Buffer.byteLength(JSON.stringify({ content: [{ type: 'text', text: body }] }), 'utf8');
}

test('the cap constant leaves headroom under the real harness ceiling', () => {
  assert.ok(MCP_RESPONSE_MAX_BYTES < HARNESS_CEILING_BYTES, 'internal cap below the real ceiling');
  assert.ok(
    HARNESS_CEILING_BYTES - MCP_RESPONSE_MAX_BYTES >= 5000,
    '≥5KB for the JSON-RPC wrapper',
  );
});

test('no-op (byte-identical) when the frame is already under the cap', () => {
  const body = 'a'.repeat(1000);
  const out = capMcpTextResponse(body, MCP_RESPONSE_MAX_BYTES, frameOf);
  assert.equal(out.capped, false);
  assert.equal(
    out.text,
    body,
    'passthrough is byte-identical — goldens/normal responses untouched',
  );
});

test('over-cap: frame lands under the cap AND the honest marker is present', () => {
  const body = 'line of text to fill the buffer\n'.repeat(4000);
  assert.ok(
    frameOf(body) > MCP_RESPONSE_MAX_BYTES,
    'fixture genuinely exceeds the cap (discriminating)',
  );
  const out = capMcpTextResponse(body, MCP_RESPONSE_MAX_BYTES, frameOf);
  assert.equal(out.capped, true);
  assert.ok(frameOf(out.text) <= MCP_RESPONSE_MAX_BYTES, 'capped frame is under the internal cap');
  assert.ok(frameOf(out.text) < HARNESS_CEILING_BYTES, 'and under the REAL harness ceiling');
  assert.ok(out.text.includes(CAP_MARKER), 'the cut carries the !! OUTPUT CAPPED honesty marker');
  assert.ok(
    out.text.startsWith('line of text'),
    'verdict-first: the head survives, the tail is cut',
  );
});

test('convergence with JSON-escape-heavy content (non-linear serialize inflation)', () => {
  // A body of all `"` — each escapes to `\"` on serialize, so the frame is ~2× the text length.
  // A naive text-length cap would undershoot; the frame-measured loop must still converge under cap.
  const body = '"'.repeat(80_000);
  const out = capMcpTextResponse(body, MCP_RESPONSE_MAX_BYTES, frameOf);
  assert.equal(out.capped, true);
  assert.ok(
    frameOf(out.text) <= MCP_RESPONSE_MAX_BYTES,
    'converged under the cap despite 2× inflation',
  );
  assert.ok(out.text.includes(CAP_MARKER));
});

test('UTF-8 boundary safety: a multi-byte body is never split mid-rune', () => {
  // '→' is 3 bytes (E2 86 92); no newlines, so the cut falls back to the byte-boundary path.
  const body = '→'.repeat(60_000);
  const out = capMcpTextResponse(body, MCP_RESPONSE_MAX_BYTES, frameOf);
  assert.equal(out.capped, true);
  assert.ok(frameOf(out.text) <= MCP_RESPONSE_MAX_BYTES);
  // Round-trip through UTF-8: a split rune would produce U+FFFD replacement chars.
  const roundTripped = Buffer.from(out.text, 'utf8').toString('utf8');
  assert.equal(roundTripped, out.text, 'no lossy re-encode → no rune was split');
  assert.ok(!out.text.replace(CAP_MARKER, '').includes('�'), 'no replacement char in the body');
});

test('idempotent: capping an already-capped payload is a no-op', () => {
  const body = 'x'.repeat(200_000);
  const once = capMcpTextResponse(body, MCP_RESPONSE_MAX_BYTES, frameOf);
  const twice = capMcpTextResponse(once.text, MCP_RESPONSE_MAX_BYTES, frameOf);
  assert.equal(twice.capped, false, 'second pass sees an under-cap payload');
  assert.equal(twice.text, once.text, 'and returns it unchanged');
});

test('cappedJsonEnvelope is valid, small JSON carrying the honest capped signal', () => {
  const env = cappedJsonEnvelope(123_456, MCP_RESPONSE_MAX_BYTES);
  assert.ok(Buffer.byteLength(env, 'utf8') < 1000, 'the replacement is tiny');
  const parsed = JSON.parse(env) as Record<string, unknown>;
  assert.equal(parsed['error'], 'output_capped');
  assert.equal(parsed['limit'], MCP_RESPONSE_MAX_BYTES);
  assert.equal(parsed['bytes'], 123_456);
  assert.equal(typeof parsed['hint'], 'string');
});
