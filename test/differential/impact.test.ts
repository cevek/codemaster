// `impact` against the real Language Service, oracle = a HAND-CURATED transitive-dependent
// set per fixture (the fixture is input; the ground truth is written here, never read back
// from the tool). Covers the spec's done-definition: a known transitive closure, a
// dynamic-dispatch hop that MUST surface as dynamic/partial (and whose invisible consumer
// must NOT be claimed as a dependent), a depth-cap case that reports truncation, and a
// cycle that terminates (visited-set — asserted by the test simply completing).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { project } from '../helpers/project.ts';
import type { OpResult } from '../../src/ops/contracts.ts';

type GroupRow = { id: string; name: string; file: string; roles: string };
type ImpactData = {
  target: { id: string; name: string; kind: string };
  summary: {
    depth: number;
    dependents: number;
    complete: boolean;
    byDepth: Record<string, number>;
  };
  notes?: string[];
  dynamicBoundaries?: string[];
  dependents?: Record<string, GroupRow[]>;
};

function dataOf(r: OpResult): ImpactData {
  assert.ok('result' in r && r.result.ok, JSON.stringify(r));
  return r.result.data as ImpactData;
}

/** Flatten the by-depth listing into `{name, depth}` so a hand-curated set is easy to
 *  assert against. */
function depsByName(d: ImpactData): { name: string; depth: number }[] {
  const out: { name: string; depth: number }[] = [];
  for (const [depth, rows] of Object.entries(d.dependents ?? {})) {
    for (const row of rows) out.push({ name: row.name, depth: Number(depth) });
  }
  return out;
}

test('known transitive closure: dependents land at their hand-curated depths', async () => {
  const p = await project({
    'tsconfig.json': '{"compilerOptions":{"strict":true}}',
    'src/core.ts': 'export const core = (n: number): number => n + 1;\n',
    'src/mid.ts':
      "import { core } from './core';\nexport const mid = (n: number): number => core(n) + 1;\n",
    'src/top.ts': "import { mid } from './mid';\nexport const top = (): number => mid(2);\n",
  });
  try {
    const d = dataOf(await p.op('impact', { name: 'core', depth: 3 }));
    assert.equal(d.target.name, 'core');
    const deps = depsByName(d);
    // Hand-read ground truth: mid calls core (depth 1); top calls mid (depth 2); nothing else.
    assert.deepEqual(
      deps.map((x) => `${x.name}@${x.depth}`).sort(),
      ['mid@1', 'top@2'],
      'exact transitive closure with correct proximity depths',
    );
    assert.equal(d.summary.complete, true, 'no caps, no dynamic boundaries → complete');

    // Chainable SymbolIds: a depth-1 dependent id feeds straight back into find_usages.
    const midId = (d.dependents?.['1'] ?? []).find((r) => r.name === 'mid')?.id;
    if (midId === undefined) throw new Error('mid dependent missing an id');
    assert.ok(midId.startsWith('ts:'), 'dependent carries a chainable ts: SymbolId');
    const chained = await p.op('find_usages', { symbol: midId });
    assert.ok('result' in chained && chained.result.ok, 'the dependent id resolves on its own');
  } finally {
    await p.dispose();
  }
});

test('dynamic-dispatch hop surfaces as a dynamic boundary; the invisible consumer is NOT claimed', async () => {
  const p = await project({
    'tsconfig.json': '{"compilerOptions":{"strict":true}}',
    'src/handler.ts': "export const handler = (): string => 'hi';\n",
    // `handler` stored as a VALUE in a registry, then dispatched via a computed key — the
    // dispatcher `dispatch` is invisible to find_usages(handler) (the LS cannot link a
    // computed-member call back to the stored value).
    'src/registry.ts':
      "import { handler } from './handler';\n" +
      'const reg: Record<string, () => string> = { go: handler };\n' +
      'export const dispatch = (k: string): string => reg[k]!();\n',
    // A plain direct caller — the certain, statically-resolved dependent.
    'src/direct.ts':
      "import { handler } from './handler';\nexport const direct = (): string => handler();\n",
  });
  try {
    const d = dataOf(await p.op('impact', { name: 'handler', depth: 3 }));
    const names = depsByName(d).map((x) => x.name);

    // The direct caller is a certain dependent.
    assert.ok(names.includes('direct'), 'the direct call site is a dependent');
    // The registry module-level value-read is a dependent too (it IS a reference).
    // But the DISPATCHER is never claimed — find_usages cannot prove handler flows there.
    assert.ok(
      !names.includes('dispatch'),
      'the dynamic dispatcher is NOT falsely claimed as a dependent (never bridged)',
    );

    // The escape is flagged, the closure is honestly incomplete.
    assert.equal(d.summary.complete, false, 'a value-flow escape makes the closure PARTIAL');
    assert.ok((d.dynamicBoundaries ?? []).length >= 1, 'the escape site is flagged');
    assert.ok(
      (d.dynamicBoundaries ?? []).some((b) => b.includes('handler') && b.includes('value')),
      'the boundary names the symbol read as a value',
    );
    assert.ok(
      (d.notes ?? []).some((n) => /PARTIAL/.test(n)),
      'a partial-closure note is surfaced before the bulk',
    );
  } finally {
    await p.dispose();
  }
});

test('depth cap reports truncation and never reads as complete', async () => {
  const p = await project({
    'tsconfig.json': '{"compilerOptions":{"strict":true}}',
    'src/core.ts': 'export const core = (n: number): number => n + 1;\n',
    'src/mid.ts':
      "import { core } from './core';\nexport const mid = (n: number): number => core(n) + 1;\n",
    'src/top.ts': "import { mid } from './mid';\nexport const top = (): number => mid(2);\n",
  });
  try {
    const d = dataOf(await p.op('impact', { name: 'core', depth: 1 }));
    assert.deepEqual(
      depsByName(d).map((x) => x.name),
      ['mid'],
      'only depth-1 dependents shown',
    );
    assert.equal(d.summary.complete, false);
    assert.ok(
      (d.notes ?? []).some((n) => /reached depth cap/.test(n) && n.includes('!!')),
      'depth-cap truncation is flagged !!',
    );
  } finally {
    await p.dispose();
  }
});

test('a dependency cycle terminates (visited-set) — the call returns, no hang', async () => {
  const p = await project({
    'tsconfig.json': '{"compilerOptions":{"strict":true}}',
    'src/a.ts':
      "import { b } from './b';\nexport function a(n: number): number { return n <= 0 ? 0 : b(n - 1); }\n",
    'src/b.ts':
      "import { a } from './a';\nexport function b(n: number): number { return n <= 0 ? 0 : a(n - 1); }\n",
  });
  try {
    // If the visited-set failed, this would not return — the test timing out IS the failure.
    const d = dataOf(await p.op('impact', { name: 'a', depth: 10 }));
    const names = depsByName(d).map((x) => x.name);
    assert.ok(names.includes('b'), 'b (mutual recursion) is a dependent of a');
    assert.ok(!names.includes('a'), 'the seed never lists itself despite the cycle');
    assert.ok(d.summary.dependents < 5, 'the closure is finite, not runaway');
  } finally {
    await p.dispose();
  }
});

test('filters are a VIEW over the COMPLETE closure — never prune the transitive walk', async () => {
  // top (exported) depends on target only THROUGH helper (unexported). A filter that pruned
  // the walk would lose `top` and falsely report "nothing exported depends on target".
  const p = await project({
    'tsconfig.json': '{"compilerOptions":{"strict":true}}',
    'src/target.ts': 'export const target = (): number => 1;\n',
    'src/mid.ts':
      "import { target } from './target';\n" +
      'const helper = (): number => target();\n' +
      'export const top = (): number => helper();\n',
  });
  try {
    const d = dataOf(await p.op('impact', { name: 'target', exportedOnly: true }));
    const names = depsByName(d).map((x) => x.name);
    assert.ok(names.includes('top'), 'the exported transitive dependent survives the filter');
    assert.ok(!names.includes('helper'), 'the unexported intermediate is hidden from the view');
    // The closure itself is complete (the walk went through helper); the filter only hid it.
    assert.equal(d.summary.dependents, 2, 'summary counts the FULL closure, not the filtered view');
    assert.equal(d.summary.complete, true, 'a filter never makes the closure read incomplete');
    assert.ok(
      (d.notes ?? []).some((n) => /hidden by your/.test(n)),
      'the hidden count is surfaced, never silent',
    );
  } finally {
    await p.dispose();
  }
});

test('a transitive chain through a top-level value binding dead-ends HONESTLY (not silently complete)', async () => {
  // `export const b = a()` rolls the `a` ref up to b.ts module scope; that module node
  // cannot be re-expanded by SymbolId, so `c` (which depends on b) is unreachable here. The
  // honest contract: flag the un-expandable dead-end and report the closure incomplete —
  // never `complete: true` over a dropped branch.
  const p = await project({
    'tsconfig.json': '{"compilerOptions":{"strict":true}}',
    'src/a.ts': 'export const a = (): number => 1;\n',
    'src/b.ts': "import { a } from './a';\nexport const b = a();\n",
    'src/c.ts': "import { b } from './b';\nexport const c = b + 1;\n",
  });
  try {
    const d = dataOf(await p.op('impact', { name: 'a', depth: 3 }));
    assert.equal(d.summary.complete, false, 'a value-binding dead-end must NOT read as complete');
    assert.ok(
      (d.notes ?? []).some((n) => /could not be re-expanded/.test(n) && n.includes('!!')),
      'the un-expandable module rollup is flagged !!',
    );
  } finally {
    await p.dispose();
  }
});

test('a symbol with no dependents returns an honest empty closure', async () => {
  const p = await project({
    'tsconfig.json': '{"compilerOptions":{"strict":true}}',
    'src/lonely.ts': 'export const lonely = (): number => 42;\n',
  });
  try {
    const d = dataOf(await p.op('impact', { name: 'lonely' }));
    assert.equal(d.summary.dependents, 0);
    assert.equal(d.summary.complete, true, 'empty-but-complete, not a silent failure');
  } finally {
    await p.dispose();
  }
});

test('a value-only-read callable arrow-const is a dynamic boundary (not falsely `complete`)', async () => {
  // `handler` is an arrow-const (LS kind `const`), reached ONLY as a value in `reg` — never called
  // directly. The closure past the `reg[k]()` dynamic dispatch is invisible to find_usages, so the
  // result must NOT read `complete`. A kind-only callable check missed this (post-review fix: the
  // definition's call-signature `callable` flag).
  const p = await project({
    'tsconfig.json': '{"compilerOptions":{"strict":true}}',
    'src/handler.ts': "export const handler = (): string => 'hi';\n",
    'src/registry.ts':
      "import { handler } from './handler';\n" +
      'const reg: Record<string, () => string> = { go: handler };\n' +
      'export const dispatch = (k: string): string => reg[k]!();\n',
  });
  try {
    const d = dataOf(await p.op('impact', { name: 'handler', depth: 3 }));
    assert.equal(
      d.summary.complete,
      false,
      'a value-only read of a callable const is a dynamic boundary',
    );
    assert.ok(
      (d.dynamicBoundaries?.length ?? 0) >= 1,
      'the value-read site is flagged dynamic, not bridged',
    );
  } finally {
    await p.dispose();
  }
});
