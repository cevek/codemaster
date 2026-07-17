// Batch render-flag routing (review fix #2). The synthetic `sql` result must render with
// the BATCH-level format/verbosity, never the first producer's per-request flags. Oracle:
// a producer asking format:'json' must NOT turn the SQL table into JSON.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderBatch } from '../../src/mcp/render-response.ts';
import { ok } from '../../src/common/result/construct.ts';
import type { OpResult } from '../../src/ops/contracts.ts';

const sqlResult: OpResult = { name: 'sql', result: ok({ columns: ['n'], rows: [[1]] }) };

test("sql result ignores the producer's per-request format (no leak)", () => {
  // return:'sql' → one result at index 0; the request at [0] is the PRODUCER (format json).
  const out = renderBatch([sqlResult], [{ format: 'json' }], { sqlPresent: true });
  assert.match(out, /\[0\] sql\nn {2}\(1 row\)/, 'renders the dense table, not the producer JSON');
  assert.doesNotMatch(out, /\{"ok"/, "producer's format:'json' did not leak to the SQL result");
});

test('batch-level format applies to the sql result; producers keep their own (return:all)', () => {
  const producer: OpResult = { name: 'find_usages', result: ok({ matches: [] }) };
  const out = renderBatch([producer, sqlResult], [{ format: 'text' }, {}], {
    sqlPresent: true,
    format: 'json',
  });
  assert.match(out, /\[1\] sql\n\{"ok":true/, 'sql result honors batch-level format:json');
  assert.doesNotMatch(out, /\[0\] find_usages\n\{"ok"/, 'producer keeps its own text format');
});

test('without sql, per-request flags drive every block', () => {
  const a: OpResult = { name: 'search_symbol', result: ok({ matches: [] }) };
  const out = renderBatch([a], [{ format: 'json' }], { sqlPresent: false });
  assert.match(
    out,
    /\[0\] search_symbol\n\{"ok":true/,
    'plain batch still uses per-request format',
  );
});
