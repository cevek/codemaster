// Unit test for the sql-batch driver's honesty envelope (review fix #1, lower half): a
// producer that reports its OWN internal truncation (`result.truncated`) must mark its
// table `partial`, even when the projected row count sits below MAX_TABLE_ROWS — the
// bound check alone would miss it, and a silent NOT IN over a capped table lies (§2.3).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { runSqlBatch } from '../../src/daemon/sql-batch.ts';
import { ok } from '../../src/common/result/construct.ts';
import { createSqliteRunner } from '../../src/support/sql/better-sqlite3.ts';
import { defineOp } from '../../src/ops/registry.ts';

test("a producer's own truncation marks its table partial", async () => {
  const stub = defineOp({
    name: 'stub',
    summary: 'stub',
    mutating: false,
    requires: [],
    argsSchema: z.strictObject({}),
    argsHint: '{}',
    table: {
      columns: [
        { name: 'n', type: 'int' },
        { name: 'confidence', type: 'text' },
      ],
      rows: () => [[1, 'certain']],
    },
    run: () =>
      Promise.resolve(
        ok({ items: [1] } as never, { truncated: { shown: 1, total: 5, hint: 'internal cap' } }),
      ),
  });

  const results = await runSqlBatch({
    reqs: [{ name: 'stub', args: {} }],
    sql: 'SELECT n FROM t',
    returnMode: 'sql',
    opsByName: new Map([['stub', stub]]),
    hasPlugin: () => true,
    bounds: { maxTableRows: 100, maxResultRows: 100 },
    createRunner: createSqliteRunner,
    runProducer: (req) =>
      stub
        .run({ plugins: undefined as never, flags: {}, tableRowBound: 100 }, req.args)
        .then((result) => ({ name: req.name, result })),
    freshness: undefined,
  });
  const r = results[0];
  assert.ok(r !== undefined && 'result' in r && r.result.ok);
  const partial = (r.result.data as { partial?: { boundedTables: string[] } }).partial;
  assert.ok(partial !== undefined, 'producer-internal truncation must surface as partial');
  assert.deepEqual(partial.boundedTables, ['t']);
});
