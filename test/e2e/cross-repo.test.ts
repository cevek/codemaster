// cross-repo spec §3: per-request `root` lets one batch span sibling repos. Oracle = the
// same op run single-root against each fixture repo (results must be identical), plus
// order preservation, per-request DispatchError isolation, cross-root sql, and honest
// per-engine freshness.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'node:path';
import { multiRepo } from '../helpers/multi-repo.ts';
import type { OpResult } from '../../src/ops/contracts.ts';

const TSCONFIG = '{"compilerOptions":{"strict":true}}';
type Matches = { matches: { name: string; id: string; span: { file: string } }[] };

/** Narrow a positional result (the `!`-free way the lint rules want). */
function at(results: readonly OpResult[], i: number): OpResult {
  const r = results[i];
  assert.ok(r !== undefined, `expected a result at index ${i}`);
  return r;
}
function okData<T>(results: readonly OpResult[], i: number): T {
  const r = at(results, i);
  assert.ok('result' in r && r.result.ok, `expected ok at ${i}: ${JSON.stringify(r)}`);
  return r.result.data as T;
}

function repos() {
  return multiRepo({
    A: {
      'tsconfig.json': TSCONFIG,
      'src/a.ts': "export const alpha = 1;\nexport const shared = 'A';\n",
    },
    B: {
      'tsconfig.json': TSCONFIG,
      'src/b.ts': "export const beta = 2;\nexport const shared = 'B';\n",
    },
  });
}

test('mixed-root batch: each answer is correct and results stay in request order', async () => {
  const m = await repos();
  try {
    const results = await m.request([
      { name: 'search_symbol', args: { query: 'alpha' }, root: m.root('A') },
      { name: 'search_symbol', args: { query: 'beta' }, root: m.root('B') },
      { name: 'search_symbol', args: { query: 'alpha' }, root: m.root('A') },
    ]);
    // Order preserved across the per-engine grouping: A, B, A.
    assert.equal(okData<Matches>(results, 0).matches[0]?.span.file, 'src/a.ts');
    assert.equal(okData<Matches>(results, 1).matches[0]?.span.file, 'src/b.ts');
    assert.equal(okData<Matches>(results, 2).matches[0]?.span.file, 'src/a.ts');

    // Oracle: the same op single-rooted against B must equal the mixed-batch B answer.
    const bOnly = await m.request(
      [{ name: 'search_symbol', args: { query: 'beta' } }],
      undefined,
      m.root('B'),
    );
    assert.deepEqual(okData(results, 1), okData(bOnly, 0));
  } finally {
    await m.dispose();
  }
});

test('request-level root overrides tool-level root', async () => {
  const m = await repos();
  try {
    // tool root = A, request root = B; `shared` exists in both at different files. The
    // request root must win → the B copy.
    const r = await m.request(
      [{ name: 'search_symbol', args: { query: 'shared' }, root: m.root('B') }],
      undefined,
      m.root('A'),
    );
    assert.equal(okData<Matches>(r, 0).matches[0]?.span.file, 'src/b.ts');
  } finally {
    await m.dispose();
  }
});

test('an unresolvable root yields a per-request DispatchError; siblings still run', async () => {
  const m = await repos();
  try {
    const results = await m.request([
      { name: 'search_symbol', args: { query: 'alpha' }, root: m.root('A') },
      { name: 'search_symbol', args: { query: 'x' }, root: '/no/such/codemaster/dir' },
    ]);
    assert.ok(
      'result' in at(results, 0) && okData<Matches>(results, 0).matches.length >= 1,
      'sibling ran',
    );
    const bad = at(results, 1);
    assert.ok('error' in bad && bad.error.kind === 'bad_args', 'bad root → DispatchError');
    assert.match(bad.error.message, /no\/such\/codemaster\/dir|not exist|canonical/i);
  } finally {
    await m.dispose();
  }
});

test('a mixed-root batch spins one engine per root; status lists the warm roots', async () => {
  const m = await repos();
  try {
    await m.request([
      { name: 'search_symbol', args: { query: 'alpha' }, root: m.root('A') },
      { name: 'search_symbol', args: { query: 'beta' }, root: m.root('B') },
    ]);
    const warm = (await m.status()).split('\n').find((l) => l.startsWith('warm roots:')) ?? '';
    assert.ok(warm.includes(path.basename(m.root('A'))), 'repo A is a warm root');
    assert.ok(warm.includes(path.basename(m.root('B'))), 'repo B is a warm root');
  } finally {
    await m.dispose();
  }
});

test('cross-root sql anti-join runs the join at the orchestrator', async () => {
  const m = await multiRepo({
    A: {
      'tsconfig.json': TSCONFIG,
      'src/a.ts':
        'export const widget = () => 1;\nexport const Common = () => widget();\nexport const OnlyA = () => widget();\n',
    },
    B: {
      'tsconfig.json': TSCONFIG,
      'src/b.ts': 'export const widget = () => 1;\nexport const Common = () => widget();\n',
    },
  });
  try {
    const results = await m.request(
      [
        {
          as: 'a',
          name: 'find_usages',
          args: { symbols: ['widget'], groupBy: 'enclosing' },
          root: m.root('A'),
        },
        {
          as: 'b',
          name: 'find_usages',
          args: { symbols: ['widget'], groupBy: 'enclosing' },
          root: m.root('B'),
        },
      ],
      {
        sql: "SELECT encloser FROM a WHERE encloser_kind='function' AND encloser NOT IN (SELECT encloser FROM b WHERE encloser_kind='function')",
      },
    );
    const sqlIdx = results.findIndex((r) => r.name === 'sql');
    const { rows } = okData<{ rows: string[][] }>(results, sqlIdx);
    // Hand-computed oracle: A's function enclosers (Common, OnlyA) minus B's (Common) = OnlyA.
    assert.deepEqual(rows.map((r) => r[0]).sort(), ['OnlyA']);
  } finally {
    await m.dispose();
  }
});

test('cross-root freshness is honest: mutating B reindexes only B-rooted answers', async () => {
  const m = await repos();
  try {
    await m.request([
      { name: 'search_symbol', args: { query: 'alpha' }, root: m.root('A') },
      { name: 'search_symbol', args: { query: 'beta' }, root: m.root('B') },
    ]);
    // Mutate B silently (nullWatcher) — only B's read-time backstop should fire.
    m.write(
      'B',
      'src/b.ts',
      "export const beta = 2;\nexport const shared = 'B';\nexport const added = 3;\n",
    );
    const after = await m.request([
      { name: 'search_symbol', args: { query: 'alpha' }, root: m.root('A') },
      { name: 'search_symbol', args: { query: 'beta' }, root: m.root('B') },
    ]);
    const a = at(after, 0);
    const b = at(after, 1);
    assert.ok('result' in a && a.result.ok && 'result' in b && b.result.ok);
    assert.equal(a.result.freshness?.reindexed, undefined, 'repo A was not touched');
    assert.ok((b.result.freshness?.reindexed ?? 0) >= 1, 'repo B reindexed its mutated file');
  } finally {
    await m.dispose();
  }
});

test('a SymbolId from repo A fails honestly when its file is absent in repo B (no silent miss)', async () => {
  const m = await repos();
  try {
    const search = await m.request(
      [{ name: 'search_symbol', args: { query: 'alpha' } }],
      undefined,
      m.root('A'),
    );
    const symbol = okData<Matches>(search, 0).matches[0]?.id;
    assert.ok(symbol !== undefined);
    // alpha lives in A's src/a.ts; B has no src/a.ts → the B-rooted handle can't resolve.
    const r = await m.request([
      { name: 'find_definition', args: { symbolId: symbol }, root: m.root('B') },
    ]);
    const res = at(r, 0);
    assert.ok(
      'result' in res && !res.result.ok,
      'cross-root handle must fail, never a wrong answer',
    );
  } finally {
    await m.dispose();
  }
});

test('§4b: SymbolIds are origin-gated — a handle from A is NOT name-rebound onto B’s same-named symbol', async () => {
  // A SymbolId now carries the workspace root it was minted in (a `~rootTag` suffix). Even when B
  // has the SAME relpath + name + offset, an A-minted handle dispatched to B must NOT resolve
  // positionally against B (that would bind the handle to a DIFFERENT repo's symbol) — it reports
  // `gone` and tells the agent to re-search in the new root. (Previously this was an undetectable
  // positional collision — spec-stresstest §4b fixed it; ARCHITECTURE §6 "SymbolIds do not cross
  // roots".)
  const same = (value: string) => `export const thing = '${value}';\n`;
  const m = await multiRepo({
    A: { 'tsconfig.json': TSCONFIG, 'src/same.ts': same('A_VALUE') },
    B: { 'tsconfig.json': TSCONFIG, 'src/same.ts': same('B_VALUE') },
  });
  try {
    const search = await m.request(
      [{ name: 'search_symbol', args: { query: 'thing' } }],
      undefined,
      m.root('A'),
    );
    const symbol = okData<Matches>(search, 0).matches[0]?.id;
    assert.ok(symbol !== undefined);
    const r = await m.request([
      { name: 'find_definition', args: { symbolId: symbol }, root: m.root('B') },
    ]);
    const res = at(r, 0);
    assert.ok(
      'result' in res && !res.result.ok,
      'a cross-root handle must NOT resolve against B even on an identical relpath+name+pos',
    );
    if ('result' in res && !res.result.ok) {
      assert.match(
        res.result.failure.message,
        /different workspace root|do not cross roots|re-search/i,
      );
    }
  } finally {
    await m.dispose();
  }
});

test('§4c: a non-TS folder is NOT warmed — status names the cause instead of a silent workspace', async () => {
  // A Java repo (no tsconfig, no tracked .ts/.tsx) must be refused, not silently warmed (which
  // would index nothing useful and read as success). status names why.
  const m = await multiRepo({
    Java: { 'src/Main.java': 'class Main {}\n', 'README.md': '# not typescript\n' },
  });
  try {
    const status = await m.status(m.root('Java'));
    assert.match(
      status,
      /workspace: none resolved/,
      'a non-TS folder must not resolve a workspace',
    );
    assert.match(
      status,
      /no TS project|tsconfig|TypeScript/i,
      'status must name WHY (not a TS project)',
    );
  } finally {
    await m.dispose();
  }
});

test('§4c: an unresolvable root surfaces the cause in status (never a bare "none resolved")', async () => {
  const m = await multiRepo({
    A: { 'tsconfig.json': TSCONFIG, 'src/a.ts': 'export const a = 1;\n' },
  });
  try {
    const status = await m.status('/no/such/codemaster/root/xyz');
    assert.match(
      status,
      /workspace: none resolved —/,
      'the cause must be appended, not a bare none',
    );
    assert.match(
      status,
      /no\/such\/codemaster\/root\/xyz|not exist|canonical/i,
      'names the bad root',
    );
  } finally {
    await m.dispose();
  }
});

test('governor stays enforced across roots: a 2-root batch under maxEngines:1 still answers both', async () => {
  const m = await multiRepo(
    {
      A: { 'tsconfig.json': TSCONFIG, 'src/a.ts': 'export const alpha = 1;\n' },
      B: { 'tsconfig.json': TSCONFIG, 'src/b.ts': 'export const beta = 2;\n' },
    },
    { maxEngines: 1 },
  );
  try {
    const results = await m.request([
      { name: 'search_symbol', args: { query: 'alpha' }, root: m.root('A') },
      { name: 'search_symbol', args: { query: 'beta' }, root: m.root('B') },
    ]);
    // Both answers correct even though the LRU budget evicts A while serving B...
    okData(results, 0);
    okData(results, 1);
    // ...and the budget is actually ENFORCED: two roots were touched, but never more than
    // one engine stays warm (the spec's "LRU budget still enforced" claim).
    const header = (await m.status()).split('\n')[0] ?? '';
    assert.match(header, /engines=1\b/, 'maxEngines:1 caps the warm-engine count at 1');
  } finally {
    await m.dispose();
  }
});
