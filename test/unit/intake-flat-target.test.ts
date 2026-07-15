// The liberal-intake layer (§7 Postel), part 2 — the `query`→canonical / flat-target / global-
// alias / nested-array classes (t-954279 + t-684957). Split from intake.test.ts (300-line cap);
// shared fixture + narrowers in ../helpers/intake.ts. Each bad spelling must (a) SUCCEED with the
// SAME result as the canonical spelling (the canonical call is the oracle) and (b) disclose the
// rewrite via `Result.intake` — plus the honesty boundary: a wrong-KIND key hard-rejects, an
// unknown non-flat key is never silently stripped.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { project, type TestProject } from '../helpers/project.ts';
import { nestedArrayFieldsOf } from '../../src/ops/intake/shape-keys.ts';
import { z } from 'zod';
import { FILES, okResult, dataJson, badArgs, defId } from '../helpers/intake.ts';
import type { JsonValue } from '../../src/core/json.ts';

// ── class G — `query`→canonical for the flat-name ops (t-954279). Agents anchor on `query`
// after search_symbol/list and carry it to a flat-name op. The bidirectional partner of class A
// (search_symbol's `name`→`query`). Oracle = the canonical `{name}` call, per op.
const QUERY_TO_NAME_CASES: ReadonlyArray<{
  op: string;
  extra?: Record<string, JsonValue>;
  name: string;
}> = [
  { op: 'find_usages', extra: { collapseImports: false }, name: 'getInitials' },
  { op: 'find_definition', name: 'getInitials' },
  { op: 'expand_type', name: 'Props' },
  { op: 'construction_sites', name: 'Props' },
];
for (const { op, extra, name } of QUERY_TO_NAME_CASES) {
  test(`class G — ${op} \`query\`→\`name\` (same result + note)`, async () => {
    const p: TestProject = await project(FILES);
    try {
      const canon = await p.op(op, { ...extra, name });
      const byQuery = await p.op(op, { ...extra, query: name });
      assert.equal(dataJson(byQuery), dataJson(canon), 'query form == name form');
      assert.deepEqual(okResult(byQuery).intake, ['query→name']);
      assert.deepEqual(okResult(canon).intake, [], 'canonical form fires no rewrite');
    } finally {
      await p.dispose();
    }
  });
}

test('class G honesty — importers_of `query`/`name` is a POINTED reject, never a silent module alias', async () => {
  // §3.6: `query`/`name` denote a SYMBOL name; importers_of takes a module PATH. Aliasing would
  // turn a loud bad_args into a silent "0 importers". So it hard-rejects with a steering hint.
  const p: TestProject = await project(FILES);
  try {
    for (const key of ['query', 'name'] as const) {
      const msg = badArgs(await p.op('importers_of', { [key]: 'getInitials' }));
      assert.match(msg, new RegExp(`'${key}' looks like a symbol name`), `${key}: names the key`);
      assert.match(msg, /module PATH/, `${key}: steers to a module path`);
      assert.doesNotMatch(msg, /alias/i, `${key}: no alias annotation leaks`);
    }
  } finally {
    await p.dispose();
  }
});

// ── class H — source flat single/list target → `targets[]` (t-684957). Every sibling lookup op
// takes a flat `{name}`/`{symbolId}`/`{file+line+col}`; source alone required `{targets:[…]}`.
// Oracle = the explicit `{targets:[…]}` call.
test('class H — source flat `{name}`/`{query}`/`{symbolId}` → one-element targets[]', async () => {
  const p: TestProject = await project(FILES);
  try {
    const id = defId(await p.op('find_usages', { name: 'getInitials', collapseImports: false }));
    const canon = await p.op('source', { targets: [{ name: 'getInitials' }] });

    const byName = await p.op('source', { name: 'getInitials' });
    assert.equal(dataJson(byName), dataJson(canon), 'flat {name} == targets[{name}]');
    assert.deepEqual(okResult(byName).intake, ['flat→targets[]']);

    const byQuery = await p.op('source', { query: 'getInitials' });
    assert.equal(dataJson(byQuery), dataJson(canon), 'flat {query} == targets[{name}]');
    assert.deepEqual(okResult(byQuery).intake, ['query→name', 'flat→targets[]']);

    const bySymbolId = await p.op('source', { symbolId: id });
    assert.equal(
      dataJson(bySymbolId),
      dataJson(await p.op('source', { targets: [{ symbolId: id }] })),
      'flat {symbolId} == targets[{symbolId}]',
    );
    assert.deepEqual(okResult(bySymbolId).intake, ['flat→targets[]']);
  } finally {
    await p.dispose();
  }
});

test('class H — source `{names:[…]}` → N-element targets[]; explicit targets[] still wins', async () => {
  const p: TestProject = await project(FILES);
  try {
    const canon = await p.op('source', {
      targets: [{ name: 'getInitials' }, { name: 'Button' }],
    });
    const byNames = await p.op('source', { names: ['getInitials', 'Button'] });
    assert.equal(dataJson(byNames), dataJson(canon), '{names:[…]} == N targets');
    assert.deepEqual(okResult(byNames).intake, ['flat→targets[]']);

    // An explicit targets[] is NEVER collapsed over (no flat note, no rewrite).
    const explicit = await p.op('source', { targets: [{ name: 'getInitials' }] });
    assert.deepEqual(okResult(explicit).intake, []);
  } finally {
    await p.dispose();
  }
});

test('class H honesty — source with an unknown non-flat key still rejects (never silent-strip)', async () => {
  const p: TestProject = await project(FILES);
  try {
    const msg = badArgs(await p.op('source', { name: 'getInitials', zzz: 1 }));
    assert.match(msg, /zzz/, 'the stray key is still named, not swallowed by the flat collapse');
    // An EMPTY `names:[]` (a meaningless intent) is NOT silently consumed — it survives to the gate.
    const empty = badArgs(await p.op('source', { names: [] }));
    assert.match(empty, /names|targets/, 'empty names[] is rejected, not silently stripped');
  } finally {
    await p.dispose();
  }
});

test('class H — source `{symbol}` flat alias matches its ts-target siblings (consistency)', async () => {
  const p: TestProject = await project(FILES);
  try {
    const bySymbol = await p.op('source', { symbol: 'getInitials' });
    const canon = await p.op('source', { targets: [{ name: 'getInitials' }] });
    assert.equal(dataJson(bySymbol), dataJson(canon), 'flat {symbol} == targets[{name}]');
    assert.deepEqual(okResult(bySymbol).intake, ['symbol→name', 'flat→targets[]']);
  } finally {
    await p.dispose();
  }
});

// ── class I — `max_results`/`maxResults`→`limit`, GUARDED to ops that have a `limit` field.
test('class I — search_symbol `max_results`→`limit` (same result + note)', async () => {
  const p: TestProject = await project(FILES);
  try {
    const canon = await p.op('search_symbol', { query: 'get', limit: 1 });
    const byMax = await p.op('search_symbol', { query: 'get', max_results: 1 });
    assert.equal(dataJson(byMax), dataJson(canon), 'max_results == limit');
    assert.deepEqual(okResult(byMax).intake, ['max_results→limit']);
  } finally {
    await p.dispose();
  }
});

test('class I honesty — `max_results` on a limit-LESS op is NOT aliased (honest reject, no stray limit)', async () => {
  // The guard: rewrite only when `limit ∈ canonicalKeys`. find_definition has no `limit`, so
  // `max_results` must fall through to the gate as an unrecognized key — never manufacture a
  // stray `limit` key that the op can't use (a worse, misleading reject).
  const p: TestProject = await project(FILES);
  try {
    const msg = badArgs(await p.op('find_definition', { name: 'getInitials', max_results: 5 }));
    assert.match(msg, /unrecognized 'max_results'/, 'the wrong key is named');
    assert.doesNotMatch(msg, /limit/, 'no stray limit key is manufactured');
  } finally {
    await p.dispose();
  }
});

// ── class J — nested scalar→array: `filter.pathExclude` (find_usages). The top-level coercion
// doesn't reach one level down; the nested subfields are derived from the schema.
test('class J — find_usages `filter.pathExclude` scalar coerced to array (same result + note)', async () => {
  const p: TestProject = await project(FILES);
  try {
    const canon = await p.op('find_usages', {
      name: 'getInitials',
      filter: { pathExclude: ['**/consumer*'] },
    });
    const scalar = await p.op('find_usages', {
      name: 'getInitials',
      filter: { pathExclude: '**/consumer*' },
    });
    assert.equal(
      dataJson(scalar),
      dataJson(canon),
      'scalar filter.pathExclude == one-element array',
    );
    assert.ok(okResult(scalar).intake.includes('filter.pathExclude→[…]'), 'rewrite disclosed');
  } finally {
    await p.dispose();
  }
});

test('nestedArrayFieldsOf — detects array subfields of a (wrapped) object field; skips scalar/union', () => {
  const schema = z.strictObject({
    filter: z
      .strictObject({
        pathExclude: z.array(z.string()).min(1).optional(),
        pathInclude: z.array(z.string()).optional(),
        kind: z.string().optional(),
        flag: z.boolean().optional(),
      })
      .optional(),
    plain: z.array(z.string()), // top-level array, NOT nested — must not appear here
    scalarObj: z.strictObject({ a: z.string() }).optional(), // object, no array subfield
  });
  const nested = nestedArrayFieldsOf(schema);
  assert.deepEqual([...(nested.get('filter') ?? [])].sort(), ['pathExclude', 'pathInclude']);
  assert.ok(!nested.has('plain'), 'a top-level array field is not a nested-object entry');
  assert.ok(!nested.has('scalarObj'), 'an object with no array subfield is skipped');
});

test('nestedArrayFieldsOf — a non-object (union) schema yields the empty map, never throws', () => {
  assert.equal(nestedArrayFieldsOf(z.union([z.string(), z.number()])).size, 0);
});
