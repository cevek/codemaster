// The sql-mode read-only sandbox & robustness (spec §4, §7.5–7.6). Every hostile input
// is a pointed error, never a crash, and the engine survives to answer the next call;
// a SQL error hands back the full schema; a native-load failure is an honest ToolFailure.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { project } from '../helpers/project.ts';
import type { OpResult } from '../../src/ops/contracts.ts';
import type { Result } from '../../src/core/result.ts';
import { fail } from '../../src/common/result/construct.ts';

test('§7.5 sandbox: writes / PRAGMA / ATTACH / multi-statement / hostile alias all rejected, engine survives', async () => {
  const files = {
    'tsconfig.json': '{"compilerOptions":{"strict":true}}',
    'src/x.ts': `export const foo = 1;\nexport const bar = 2;\n`,
  };
  const p = await project(files);
  try {
    const hostile: { label: string; sql: string }[] = [
      { label: 'INSERT', sql: 'INSERT INTO t VALUES (1)' },
      { label: 'UPDATE', sql: 'UPDATE t SET name = 1' },
      { label: 'DELETE', sql: 'DELETE FROM t' },
      { label: 'DROP via multi', sql: 'SELECT 1; DROP TABLE t' },
      { label: 'PRAGMA', sql: 'PRAGMA table_info(t)' },
      { label: 'ATTACH', sql: "ATTACH DATABASE 'x.db' AS x" },
      { label: 'injection', sql: "'; DROP TABLE t; --" },
      { label: 'WITH then DELETE', sql: 'WITH c AS (SELECT 1) DELETE FROM t' },
      { label: 'line-comment hides DROP', sql: '-- harmless\nDROP TABLE t' },
      { label: 'block-comment hides INSERT', sql: '/* x */ INSERT INTO t VALUES (1)' },
    ];
    for (const h of hostile) {
      const results = await p.request(
        [{ name: 'search_symbol', as: 't', args: { query: 'foo' } }],
        {
          sql: h.sql,
        },
      );
      const r = results[0] as OpResult;
      assert.ok('error' in r, `${h.label}: expected a dispatch error, got ${JSON.stringify(r)}`);
      assert.equal(r.error.kind, 'bad_args', `${h.label}: pointed bad_args`);
    }

    // Hostile alias (reserved keyword) → bad_args before any producer runs.
    const aliasResult = await p.request(
      [{ name: 'search_symbol', as: 'select', args: { query: 'foo' } }],
      { sql: 'SELECT * FROM "select"' },
    );
    assert.ok('error' in (aliasResult[0] as OpResult));

    // Engine alive afterwards: a normal op still succeeds.
    const after = await p.op('search_symbol', { query: 'bar' });
    assert.ok('result' in after && after.result.ok, 'engine survived every rejection');
  } finally {
    await p.dispose();
  }
});

test('§7.6 schema-in-error: a bad column name lists every table and its columns', async () => {
  const p = await project({
    'tsconfig.json': '{"compilerOptions":{"strict":true}}',
    'src/x.ts': `export const foo = 1;\n`,
  });
  try {
    const results = await p.request([{ name: 'search_symbol', as: 't', args: { query: 'foo' } }], {
      sql: 'SELECT no_such_column FROM t',
    });
    const r = results[0] as OpResult;
    assert.ok('error' in r);
    assert.match(r.error.message, /t\(/, 'names the table');
    assert.match(r.error.message, /name|kind|confidence/, 'lists the columns the agent can use');
  } finally {
    await p.dispose();
  }
});

test('§4.1 native-load failure → honest ToolFailure with install hint, not a crash', async () => {
  const p = await project(
    {
      'tsconfig.json': '{"compilerOptions":{"strict":true}}',
      'src/x.ts': `export const foo = 1;\n`,
    },
    {
      createSqlRunner: () =>
        fail({ tool: 'better-sqlite3', message: 'native module not built — npm i better-sqlite3' }),
    },
  );
  try {
    const results = await p.request([{ name: 'search_symbol', as: 't', args: { query: 'foo' } }], {
      sql: 'SELECT * FROM t',
    });
    const r = results[0] as OpResult;
    assert.ok('result' in r && !r.result.ok, 'engine stays up; failure is structured');
    assert.match(
      (r.result as Extract<Result<unknown>, { ok: false }>).failure.message,
      /native module/,
    );
  } finally {
    await p.dispose();
  }
});
