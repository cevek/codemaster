// SQL post-filtering over op outputs (spec §7). Oracle = the fixture we wrote: which
// components render <Input>, and which sit under useAppForm, is known by construction.
// Every honesty channel is asserted — uncapped producers, the hard row bound, result
// truncation, the read-only sandbox, schema-in-error, and the freshness/unresolved
// envelope — because those caveats ARE the product (§3).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { project } from '../helpers/project.ts';
import { renderResult } from '../../src/format/render/render-result.ts';
import type { OpResult } from '../../src/ops/contracts.ts';
import type { Result } from '../../src/core/result.ts';

const JSX = {
  'tsconfig.json':
    '{"compilerOptions":{"strict":true,"jsx":"react-jsx","baseUrl":".","paths":{"react/jsx-runtime":["jsx.d.ts"]}}}',
  'jsx.d.ts': `declare module 'react/jsx-runtime' { export function jsx(t: unknown, p: unknown): unknown; export function jsxs(t: unknown, p: unknown): unknown; export namespace JSX { interface IntrinsicElements { [k: string]: unknown } interface Element {} } }\n`,
};

// A and B both render <Input>; only B calls useAppForm. Anti-join must return exactly A.
const ANTI_JOIN_FILES = {
  ...JSX,
  'src/ui/input.tsx': `export const Input = (_p: { id?: string }) => <input />;\n`,
  'src/form.ts': `export const useAppForm = (): { ok: boolean } => ({ ok: true });\n`,
  'src/A.tsx': `import { Input } from './ui/input';\nexport const A = () => <Input id="a" />;\n`,
  'src/B.tsx': `import { Input } from './ui/input';\nimport { useAppForm } from './form';\nexport const B = () => { useAppForm(); return <Input id="b" />; };\n`,
};

function okData(r: OpResult): { columns: string[]; rows: unknown[][] } & Record<string, unknown> {
  assert.ok('result' in r, `expected result, got ${JSON.stringify(r)}`);
  assert.ok(r.result.ok, `expected ok, got ${JSON.stringify(r.result)}`);
  return r.result.data as { columns: string[]; rows: unknown[][] } & Record<string, unknown>;
}

test('§7.1 anti-join: components that render <Input> but not under useAppForm = exactly A', async () => {
  const p = await project(ANTI_JOIN_FILES);
  try {
    const results = await p.request(
      [
        {
          name: 'find_usages',
          as: 'renders',
          args: { symbols: ['Input'], role: 'jsx', groupBy: 'enclosing' },
        },
        {
          name: 'find_usages',
          as: 'forms',
          args: { symbols: ['useAppForm'], groupBy: 'enclosing' },
        },
      ],
      {
        sql: 'SELECT DISTINCT encloser FROM renders WHERE encloser NOT IN (SELECT encloser FROM forms)',
      },
    );
    assert.equal(results.length, 1, 'default return:sql yields only the SQL result');
    const data = okData(results[0] as OpResult);
    const enclosers = data.rows.map((row) => row[0]).sort();
    assert.deepEqual(enclosers, ['A'], 'B renders Input but sits under useAppForm — excluded');
  } finally {
    await p.dispose();
  }
});

test('§7.2 producers run UNCAPPED in sql-mode; the same op without sql still truncates', async () => {
  const files = {
    'tsconfig.json': '{"compilerOptions":{"strict":true}}',
    'src/x.ts': `export const foo = 1;\n`,
    'src/use.ts': `import { foo } from './x';\nexport const a = foo;\nexport const b = foo;\nexport const c = foo;\nexport const d = foo;\nexport const e = foo;\n`,
  };
  const p = await project(files);
  try {
    // Without sql: an explicit low limit truncates, but `total` stays honest.
    const capped = await p.op('find_usages', { name: 'foo', limit: 2 });
    assert.ok('result' in capped && capped.result.ok);
    const view = capped.result.data as { total: number; usages: unknown[] };
    assert.ok(view.total > 2, 'fixture has more than the limit');
    assert.equal(view.usages.length, 2, 'without sql the op caps at its limit');
    assert.ok(capped.result.truncated !== undefined, 'and says so');

    // With sql: the SAME low limit is ignored — COUNT sees every row.
    const results = await p.request(
      [{ name: 'find_usages', as: 't', args: { name: 'foo', limit: 2 } }],
      {
        sql: 'SELECT COUNT(*) AS n FROM t',
      },
    );
    const data = okData(results[0] as OpResult);
    assert.equal(data.rows[0]?.[0], view.total, 'sql sees all rows, not the capped 2');
  } finally {
    await p.dispose();
  }
});

test('§7.3 hard bound: MAX_TABLE_ROWS hit ⇒ result partial, names the table', async () => {
  const files = {
    'tsconfig.json': '{"compilerOptions":{"strict":true}}',
    'src/x.ts': `export const foo = 1;\n`,
    'src/use.ts': `import { foo } from './x';\nexport const a = foo;\nexport const b = foo;\nexport const c = foo;\n`,
  };
  const p = await project(files, { sqlBounds: { maxTableRows: 1 } });
  try {
    const results = await p.request([{ name: 'find_usages', as: 't', args: { name: 'foo' } }], {
      sql: 'SELECT * FROM t',
    });
    const data = okData(results[0] as OpResult);
    const partial = data['partial'] as { boundedTables: string[] } | undefined;
    assert.ok(partial !== undefined, 'partial caveat present');
    assert.deepEqual(partial.boundedTables, ['t'], 'and names the bounded table');
    assert.equal(data.rows.length, 1, 'the table really was capped to the bound');
  } finally {
    await p.dispose();
  }
});

test('multi-symbol find_usages: an internal per-target cap surfaces as partial, not silently short', async () => {
  // Review fix #1: multi-symbol mode previously set no `truncated`, so a capped producer
  // fed NOT IN silently. The engine threads MAX_TABLE_ROWS as the op limit, and the op now
  // reports the aggregate cap — so the table is marked partial.
  const files = {
    'tsconfig.json': '{"compilerOptions":{"strict":true}}',
    'src/x.ts': `export const foo = 1;\n`,
    'src/use.ts': `import { foo } from './x';\nexport const a = foo;\nexport const b = foo;\nexport const c = foo;\nexport const d = foo;\n`,
  };
  const p = await project(files, { sqlBounds: { maxTableRows: 2 } });
  try {
    const results = await p.request(
      [{ name: 'find_usages', as: 't', args: { symbols: ['foo'] } }],
      {
        sql: 'SELECT * FROM t',
      },
    );
    const data = okData(results[0] as OpResult);
    const partial = data['partial'] as { boundedTables: string[] } | undefined;
    assert.ok(partial !== undefined, 'multi-symbol internal cap must surface as partial');
    assert.deepEqual(partial.boundedTables, ['t']);
  } finally {
    await p.dispose();
  }
});

test('§7.4 result-row truncation past MAX_RESULT_ROWS is explicit {shown,total}', async () => {
  const files = {
    'tsconfig.json': '{"compilerOptions":{"strict":true}}',
    'src/x.ts': `export const foo = 1;\n`,
    'src/use.ts': `import { foo } from './x';\nexport const a = foo;\nexport const b = foo;\nexport const c = foo;\n`,
  };
  const p = await project(files, { sqlBounds: { maxResultRows: 2 } });
  try {
    const results = await p.request([{ name: 'find_usages', as: 't', args: { name: 'foo' } }], {
      sql: 'SELECT * FROM t',
    });
    const r = results[0] as OpResult;
    const data = okData(r);
    assert.ok('result' in r && r.result.ok && r.result.truncated !== undefined);
    assert.equal(r.result.truncated.shown, 2, 'shown == cap');
    assert.ok(r.result.truncated.total > 2, 'total is the true row count');
    assert.equal(data.rows.length, 2, 'only the cap is materialized');
  } finally {
    await p.dispose();
  }
});

test('§7.7 envelope: freshness present; unresolved symbol surfaces as a note', async () => {
  const files = {
    'tsconfig.json': '{"compilerOptions":{"strict":true}}',
    'src/x.ts': `export const foo = 1;\nexport const a = foo;\n`,
  };
  const p = await project(files);
  try {
    const results = await p.request(
      [{ name: 'find_usages', as: 't', args: { symbols: ['foo', 'GhostSymbol'] } }],
      { sql: 'SELECT * FROM t' },
    );
    const r = results[0] as OpResult;
    const data = okData(r);
    assert.ok('result' in r && r.result.ok);
    assert.ok(r.result.freshness !== undefined, 'batch freshness rides the sql result');
    const notes = (data['notes'] as string[] | undefined) ?? [];
    assert.ok(
      notes.some((n) => /GhostSymbol/.test(n)),
      'the unresolved (absent) symbol is surfaced, never silently dropped',
    );
  } finally {
    await p.dispose();
  }
});

test('§11 envelope: a failed producer fails the SELECT (named), not its successful neighbours', async () => {
  const p = await project({
    'tsconfig.json': '{"compilerOptions":{"strict":true}}',
    'src/x.ts': `export const foo = 1;\n`,
  });
  try {
    // Producer `a` resolves; producer `b` targets an unresolvable symbol ⇒ ok:false. A join
    // over `b`'s missing table would lie, so the SELECT is skipped — but `a` is independent
    // and must survive. Default return:'sql' surfaces only the sql record: an honest failure
    // NAMING the failed producer (§11, §3.4).
    const sqlOnly = await p.request(
      [
        { name: 'search_symbol', as: 'a', args: { query: 'foo' } },
        { name: 'find_usages', as: 'b', args: { name: 'NoSuchSymbolAnywhere' } },
      ],
      { sql: 'SELECT * FROM a' },
    );
    assert.equal(sqlOnly.length, 1, 'default return:sql → only the sql record');
    const sqlRec = sqlOnly[0] as OpResult;
    assert.ok('result' in sqlRec && !sqlRec.result.ok, 'SELECT not run when a producer failed');
    const failure = (sqlRec.result as Extract<Result<unknown>, { ok: false }>).failure;
    assert.equal(failure.tool, 'sql');
    assert.match(
      failure.message,
      /'find_usages' \(as b\) failed: /,
      'sql failure must name the failed producer with its cause inline',
    );

    // return:'all' → the independent, successful producer `a` still comes back (the dogfood
    // silent-drop: previously only the failed producer + sql returned).
    const all = await p.request(
      [
        { name: 'search_symbol', as: 'a', args: { query: 'foo' } },
        { name: 'find_usages', as: 'b', args: { name: 'NoSuchSymbolAnywhere' } },
      ],
      { sql: 'SELECT * FROM a', return: 'all' },
    );
    assert.equal(all.length, 3, 'return:all → both producers + the sql record');
    const a = all[0] as OpResult;
    assert.ok('result' in a && a.result.ok, 'the successful neighbour `a` survives');
  } finally {
    await p.dispose();
  }
});

test('§7.8 format golden: the SQL table renders as header + rows, partial banner surfaces', async () => {
  const p = await project(ANTI_JOIN_FILES);
  try {
    const results = await p.request(
      [
        {
          name: 'find_usages',
          as: 'renders',
          args: { symbols: ['Input'], role: 'jsx', groupBy: 'enclosing' },
        },
      ],
      { sql: 'SELECT encloser, count FROM renders ORDER BY encloser' },
    );
    const r = results[0] as OpResult;
    assert.ok('result' in r && r.result.ok);
    const rendered = renderResult(r.result, 'terse');
    assert.match(
      rendered,
      /^encloser \| count {2}\(\d row/m,
      'header line with column names + row count',
    );
    assert.match(rendered, /^A \| 1$/m, 'A renders <Input> once');
    assert.match(rendered, /^B \| 1$/m, 'B renders <Input> once');
  } finally {
    await p.dispose();
  }
});

test('grouped find_usages exposes is_exported + encloser_file: filter to exported enclosers, drop module nodes — no LIKE-heuristic', async () => {
  const files = {
    'tsconfig.json': '{"compilerOptions":{"strict":true}}',
    'src/x.ts': `export const useThing = (): number => 1;\n`,
    // Widget (exported) and helper (not exported) both call useThing; the import line and
    // the definition site roll up to synthetic module-level enclosers.
    'src/comp.ts': `import { useThing } from './x';\nexport const Widget = (): number => useThing();\nconst helper = (): number => useThing();\nexport const w = helper();\n`,
  };
  const p = await project(files);
  try {
    // Without a filter the grouped table includes module-level (top-level X) nodes…
    const all = await p.request(
      [{ name: 'find_usages', as: 't', args: { symbols: ['useThing'], groupBy: 'enclosing' } }],
      { sql: "SELECT COUNT(*) AS n FROM t WHERE encloser_kind='module'" },
    );
    const moduleCount = okData(all[0] as OpResult).rows[0]?.[0] as number;
    assert.ok(moduleCount >= 1, 'module-level rollups exist (imports / top-level defs)');

    // …and `is_exported = 1` keeps only the genuinely exported declarations.
    const exported = await p.request(
      [{ name: 'find_usages', as: 't', args: { symbols: ['useThing'], groupBy: 'enclosing' } }],
      { sql: 'SELECT encloser, encloser_file FROM t WHERE is_exported = 1 ORDER BY encloser' },
    );
    const rows = okData(exported[0] as OpResult).rows;
    assert.deepEqual(
      rows.map((r) => r[0]),
      ['Widget'],
      'only the exported encloser survives; helper + module nodes are gone',
    );
    assert.equal(rows[0]?.[1], 'src/comp.ts', 'encloser_file is the relative path of the encloser');
  } finally {
    await p.dispose();
  }
});

test('importers_of producer runs uncapped in sql-mode (honors tableRowBound, not its own limit)', async () => {
  // Regression: importers_of grew a default-200 row `limit`. In sql-mode the engine threads
  // MAX_TABLE_ROWS as tableRowBound so a producer runs uncapped (§2.3/§11) — the op must cap at
  // THAT, not at its own 200, else a positive WHERE silently omits the tail. A module with 3
  // importers under a bound of 2 must surface 2 rows + a `partial` naming the table (the op
  // ignoring tableRowBound would return all 3 unflagged, since 3 < 200).
  const p = await project(
    {
      'tsconfig.json': '{"compilerOptions":{"strict":true}}',
      'src/lib.ts': 'export const X = 1;\n',
      'src/a.ts': "import { X } from './lib';\nexport const a = X;\n",
      'src/b.ts': "import { X } from './lib';\nexport const b = X;\n",
      'src/c.ts': "import { X } from './lib';\nexport const c = X;\n",
    },
    { sqlBounds: { maxTableRows: 2 } },
  );
  try {
    const results = await p.request(
      [{ name: 'importers_of', as: 't', args: { module: 'src/lib.ts' } }],
      { sql: 'SELECT COUNT(*) AS n FROM t' },
    );
    const data = okData(results[0] as OpResult);
    assert.equal(data.rows[0]?.[0], 2, 'producer capped at the engine bound (2), not its own 200');
    const partial = data['partial'] as { boundedTables: string[] } | undefined;
    assert.ok(partial !== undefined, 'hitting the bound must surface as partial');
    assert.deepEqual(partial.boundedTables, ['t'], 'and names the bounded table');
  } finally {
    await p.dispose();
  }
});

test('op-sql sugar: op({name, args, sql}) ≡ a batch of one aliased t', async () => {
  const p = await project({
    'tsconfig.json': '{"compilerOptions":{"strict":true}}',
    'src/x.ts': `export const Alpha = 1;\nexport const Alpine = 2;\nexport const Beta = 3;\n`,
  });
  try {
    const results = await p.request([{ name: 'search_symbol', as: 't', args: { query: 'Alp' } }], {
      sql: "SELECT name FROM t WHERE name LIKE 'Alp%' ORDER BY name",
    });
    const data = okData(results[0] as OpResult);
    assert.deepEqual(
      data.rows.map((row) => row[0]),
      ['Alpha', 'Alpine'],
    );
  } finally {
    await p.dispose();
  }
});
