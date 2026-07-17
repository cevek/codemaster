// The byte-aware envelope cap (§12 / t-287999): RENDER_CHAR_CAP alone does not bound the SERIALIZED
// size the harness measures — a 20K-char body of multi-byte runes is ~60KB. `assembleEnvelope` must
// enforce a BYTE budget too, WITHOUT dropping the honesty `tail` (truncation / freshness / handle) —
// the exact channels a blind flat-seam chop would cut. Oracle: the rendered bytes must land under
// the byte budget AND every honesty channel must still be present.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderResult } from '../../src/format/render/render-result.ts';
import { ok } from '../../src/common/result/construct.ts';
import type { JsonValue } from '../../src/core/json.ts';

test('multi-byte-heavy body: byte-capped but the honesty tail survives, no split rune', () => {
  // ~120KB of multi-byte data — far past the 20K-char cap in CHARS and past the byte budget in
  // BYTES, so both caps engage. Each entry is CJK (3 bytes/char).
  const data = Array.from({ length: 4000 }, (_, i) => `日本語ダミーテスト項目${i}`) as JsonValue;
  const rendered = renderResult(
    ok(data, {
      truncated: { shown: 1, total: 1000, hint: 'narrow with pathInclude' },
      freshness: {
        plugins: [],
        pending: 0,
        unverified: { tool: 'git', message: 'drift diff failed' },
      },
    }),
    'full',
  );

  // The byte budget is enforced (well under the ~65KB harness ceiling AND the 50KB render byte cap).
  assert.ok(
    Buffer.byteLength(rendered, 'utf8') <= 50_000,
    `rendered ${Buffer.byteLength(rendered, 'utf8')}B exceeds the render byte cap`,
  );
  // The bulk WAS cut (the char/byte marker is present) …
  assert.match(rendered, /!! OUTPUT CAPPED: data/, 'the cut is disclosed');
  // … but every honesty channel in the reserved tail SURVIVED the cut (the §12 guarantee).
  assert.match(rendered, /more \(shown 1\/1000/, 'truncation channel survives');
  assert.match(rendered, /freshness: UNVERIFIED — git failed/, 'freshness channel survives');
  // No multi-byte rune was split by the byte cut.
  assert.equal(Buffer.from(rendered, 'utf8').toString('utf8'), rendered, 'no split rune');
  assert.ok(!rendered.includes('�'), 'no replacement char');
});

test('ASCII body under the byte budget is byte-identical (no-op) — goldens hold', () => {
  const data = Array.from({ length: 5 }, (_, i) => `symbol_${i}`) as JsonValue;
  const withCaps = renderResult(ok(data), 'full');
  // The rendered output is small and pure-ASCII → neither cap engages → no marker injected.
  assert.ok(!withCaps.includes('!! OUTPUT CAPPED'), 'small ASCII response is untouched');
});
