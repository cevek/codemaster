// Unit test for the sql-batch driver's honesty envelope (review fix #1, lower half): a
// producer that reports its OWN internal truncation (`result.truncated`) must mark its
// table `partial`, even when the projected row count sits below MAX_TABLE_ROWS — the
// bound check alone would miss it, and a silent NOT IN over a capped table lies (§2.3).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { runSqlBatch } from '../../src/daemon/sql-batch.ts';
import { fail, ok } from '../../src/common/result/construct.ts';
import { createSqliteRunner } from '../../src/support/sql/better-sqlite3.ts';
import { defineOp, type AnyOpDefinition } from '../../src/ops/registry.ts';

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
    opFor: (req) => (req.name === 'stub' ? stub : undefined),
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

// §3.4 honesty: a failed producer must fail only the SELECT, never silently drop its
// INDEPENDENT, successful neighbours. Repro of the amiro dogfood drop — batch of N
// producers, producer[0] fails (ok:false), producers[1..] succeed; under return:'all'
// every successful producer must still come back, plus an honest sql failure NAMING the
// failed producer.
function runStub(byName: Record<string, AnyOpDefinition>, req: { name: string; args: unknown }) {
  const op = byName[req.name];
  if (op === undefined) throw new Error(`no stub registered for '${req.name}'`);
  return op
    .run({ plugins: undefined as never, flags: {}, tableRowBound: 100 }, req.args as never)
    .then((result) => ({ name: req.name, result }));
}

function tableStub(name: string, value: number): AnyOpDefinition {
  return defineOp({
    name,
    summary: name,
    mutating: false,
    requires: [],
    argsSchema: z.strictObject({}),
    argsHint: '{}',
    table: { columns: [{ name: 'n', type: 'int' }], rows: () => [[value]] },
    run: () => Promise.resolve(ok({ items: [value] } as never)),
  });
}

test('a failed producer fails only the SELECT — neighbours survive under return:all', async () => {
  const failing = defineOp({
    name: 'boom',
    summary: 'boom',
    mutating: false,
    requires: [],
    argsSchema: z.strictObject({}),
    argsHint: '{}',
    table: { columns: [{ name: 'n', type: 'int' }], rows: () => [] },
    run: () => Promise.resolve(fail({ tool: 'ts-ls', message: "'StatusPill' ambiguous" })),
  });
  const ok1 = tableStub('keep1', 1);
  const ok2 = tableStub('keep2', 2);
  const byName: Record<string, AnyOpDefinition> = { boom: failing, keep1: ok1, keep2: ok2 };

  const reqs = [
    { name: 'boom', args: {}, as: 'a' },
    { name: 'keep1', args: {}, as: 'b' },
    { name: 'keep2', args: {}, as: 'c' },
  ];
  const results = await runSqlBatch({
    reqs,
    sql: 'SELECT n FROM b UNION ALL SELECT n FROM c',
    returnMode: 'all',
    opFor: (req) => byName[req.name],
    hasPlugin: () => true,
    bounds: { maxTableRows: 100, maxResultRows: 100 },
    createRunner: createSqliteRunner,
    runProducer: (req) => runStub(byName, req),
    freshness: undefined,
  });

  // return:'all' → every per-request result + the sql record = 4 entries.
  assert.equal(results.length, 4, 'all 3 producers + sql must return under return:all');
  const keep1 = results.find((r) => r.name === 'keep1');
  const keep2 = results.find((r) => r.name === 'keep2');
  assert.ok(
    keep1 !== undefined && 'result' in keep1 && keep1.result.ok,
    'keep1 must run + succeed',
  );
  assert.ok(
    keep2 !== undefined && 'result' in keep2 && keep2.result.ok,
    'keep2 must run + succeed',
  );

  const sql = results[results.length - 1];
  assert.ok(sql !== undefined && sql.name === 'sql', 'last entry is the sql record');
  const sqlFailed = 'error' in sql || ('result' in sql && !sql.result.ok);
  assert.ok(sqlFailed, 'SELECT must not run when a producer failed');
  const msg =
    'error' in sql
      ? sql.error.message
      : (sql.result as { failure: { message: string } }).failure.message;
  assert.match(msg, /boom|\ba\b/, 'sql failure must name the failed producer');
});

test('return:sql + a failed producer → single sql failure naming the producer', async () => {
  const failing = defineOp({
    name: 'boom',
    summary: 'boom',
    mutating: false,
    requires: [],
    argsSchema: z.strictObject({}),
    argsHint: '{}',
    table: { columns: [{ name: 'n', type: 'int' }], rows: () => [] },
    run: () => Promise.resolve(fail({ tool: 'ts-ls', message: "'StatusPill' ambiguous" })),
  });
  const ok1 = tableStub('keep1', 1);
  const byName: Record<string, AnyOpDefinition> = { boom: failing, keep1: ok1 };
  const reqs = [
    { name: 'boom', args: {}, as: 'a' },
    { name: 'keep1', args: {}, as: 'b' },
  ];
  const results = await runSqlBatch({
    reqs,
    sql: 'SELECT n FROM b',
    returnMode: 'sql',
    opFor: (req) => byName[req.name],
    hasPlugin: () => true,
    bounds: { maxTableRows: 100, maxResultRows: 100 },
    createRunner: createSqliteRunner,
    runProducer: (req) => runStub(byName, req),
    freshness: undefined,
  });
  assert.equal(results.length, 1, 'return:sql → only the sql record');
  const sql = results[0];
  assert.ok(sql !== undefined && 'result' in sql && !sql.result.ok, 'SELECT must fail');
  // Under return:'sql' there ARE no per-request results, so the sql failure must carry both
  // WHO failed and WHY inline — no re-run needed (honesty channel, bug-reviewer nit).
  assert.match(sql.result.failure.message, /'boom' \(as a\)/, 'must name the failed producer');
  assert.match(sql.result.failure.message, /'StatusPill' ambiguous/, 'must carry the cause inline');
});

test('all producers succeed → SELECT runs (no regression)', async () => {
  const ok1 = tableStub('keep1', 1);
  const ok2 = tableStub('keep2', 2);
  const byName: Record<string, AnyOpDefinition> = { keep1: ok1, keep2: ok2 };
  const reqs = [
    { name: 'keep1', args: {}, as: 'b' },
    { name: 'keep2', args: {}, as: 'c' },
  ];
  const results = await runSqlBatch({
    reqs,
    sql: 'SELECT n FROM b UNION ALL SELECT n FROM c',
    returnMode: 'sql',
    opFor: (req) => byName[req.name],
    hasPlugin: () => true,
    bounds: { maxTableRows: 100, maxResultRows: 100 },
    createRunner: createSqliteRunner,
    runProducer: (req) => runStub(byName, req),
    freshness: undefined,
  });
  assert.equal(results.length, 1, 'return:sql → only the sql record');
  const sql = results[0];
  assert.ok(sql !== undefined && 'result' in sql && sql.result.ok, 'SELECT must succeed');
  const rows = (sql.result.data as { rows: number[][] }).rows;
  assert.deepEqual(rows.map((r) => r[0]).sort(), [1, 2]);
});
