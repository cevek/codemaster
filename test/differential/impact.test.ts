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

test('a value-flow escape is flagged at the PRECISE read site; closure stays PARTIAL', async () => {
  const REG_LINE = 'const reg: Record<string, () => string> = { go: handler };';
  const p = await project({
    'tsconfig.json': '{"compilerOptions":{"strict":true}}',
    'src/handler.ts': "export const handler = (): string => 'hi';\n",
    // `handler` stored as a VALUE in a registry binding `reg`, then dispatched via a
    // computed key. `reg` is a top-level binding now (the encloser-fidelity fix), so the
    // closure reaches it AND its own dependent `dispatch` (which references `reg`
    // STATICALLY) — but the value-read of `handler` inside `reg` is still flagged a
    // dynamic boundary: handler could be dispatched to consumers find_usages cannot see.
    'src/registry.ts':
      "import { handler } from './handler';\n" +
      `${REG_LINE}\n` +
      'export const dispatch = (k: string): string => reg[k]!();\n',
    // A plain direct caller — the certain, statically-resolved dependent.
    'src/direct.ts':
      "import { handler } from './handler';\nexport const direct = (): string => handler();\n",
  });
  try {
    const d = dataOf(await p.op('impact', { name: 'handler', depth: 3 }));
    const names = depsByName(d).map((x) => x.name);

    // The direct caller + the registry binding are certain dependents; `dispatch` is now
    // reached through `reg`'s STATIC reference (the encloser fix made `reg` re-resolvable).
    assert.ok(names.includes('direct'), 'the direct call site is a dependent');
    assert.ok(names.includes('reg'), 'the value-binding that stores handler is a dependent');
    assert.ok(
      names.includes('dispatch'),
      'a dependent of the now-re-resolvable binding is reachable (no module dead-end)',
    );

    // The escape is flagged AND the closure is honestly PARTIAL despite reaching further.
    assert.equal(d.summary.complete, false, 'a value-flow escape makes the closure PARTIAL');
    assert.ok((d.dynamicBoundaries ?? []).length >= 1, 'the escape site is flagged');
    assert.ok(
      (d.dynamicBoundaries ?? []).some((b) => b.includes('handler') && b.includes('value')),
      'the boundary names the symbol read as a value',
    );
    // Precise escape-site span: the boundary points at the exact `handler` value-read
    // TOKEN (registry.ts:2:<col-of-handler>), not at `reg`'s name token (col 7).
    const handlerCol = REG_LINE.indexOf('handler') + 1; // 1-based column on line 2
    assert.ok(
      (d.dynamicBoundaries ?? []).some((b) => b.includes(`src/registry.ts:2:${handlerCol}`)),
      'the boundary points at the precise value-read token, not the encloser name',
    );
    assert.ok(
      (d.notes ?? []).some((n) => /PARTIAL/.test(n)),
      'a partial-closure note is surfaced before the bulk',
    );
  } finally {
    await p.dispose();
  }
});

test('a consumer reached ONLY through dynamic dispatch is never bridged (closure honest-incomplete)', async () => {
  // `handler` is registered by value into a bus and invoked by a computed key. `useIt`
  // depends on the runtime dispatch but holds NO static reference to `handler` (nor to any
  // binding that transitively reaches it without crossing the dynamic `reg[k]()` hop). The
  // honest contract: `useIt` is NEVER claimed as a dependent, and the closure reports
  // itself incomplete rather than silently stopping.
  const p = await project({
    'tsconfig.json': '{"compilerOptions":{"strict":true}}',
    'src/bus.ts':
      'export const reg: Record<string, () => string> = {};\n' +
      'export const register = (k: string, fn: () => string): void => {\n  reg[k] = fn;\n};\n' +
      'export const invoke = (k: string): string => reg[k]!();\n',
    'src/handler.ts':
      "import { register } from './bus';\n" +
      "export const handler = (): string => 'hi';\n" +
      "register('go', handler);\n",
    'src/consumer.ts':
      "import { invoke } from './bus';\n" + "export const useIt = (): string => invoke('go');\n",
  });
  try {
    const d = dataOf(await p.op('impact', { name: 'handler', depth: 4 }));
    const names = depsByName(d).map((x) => x.name);
    assert.ok(
      !names.includes('useIt'),
      'the dynamically-dispatched consumer is NOT falsely claimed (never bridged)',
    );
    assert.equal(d.summary.complete, false, 'the closure honestly reports itself incomplete');
    assert.ok(
      (d.notes ?? []).some((n) => n.includes('!!')),
      'the incompleteness is flagged !! (unexpandable / dynamic), never silent',
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

test('impact expands THROUGH a top-level value binding to its own dependents (no dead-end)', async () => {
  // `export const b = a()` now rolls the `a` reference up to the binding `b` (a
  // re-resolvable `b@src/b.ts:…` SymbolId), not to the un-re-queryable module node. So the
  // chain a → b → c no longer dead-ends: impact follows b's own dependent `c` (which reads
  // b), and the closure is COMPLETE — the former honest dead-end is genuinely closed.
  const p = await project({
    'tsconfig.json': '{"compilerOptions":{"strict":true}}',
    'src/a.ts': 'export const a = (): number => 1;\n',
    'src/b.ts': "import { a } from './a';\nexport const b = a();\n",
    'src/c.ts': "import { b } from './b';\nexport const c = b + 1;\n",
  });
  try {
    const d = dataOf(await p.op('impact', { name: 'a', depth: 3 }));
    const deps = depsByName(d);
    assert.deepEqual(
      deps.map((x) => `${x.name}@${x.depth}`).sort(),
      ['b@1', 'c@2'],
      'expands through the binding b (depth 1) to its own dependent c (depth 2)',
    );
    assert.equal(d.summary.complete, true, 'the re-resolvable binding closes the former dead-end');
    assert.ok(
      (d.notes ?? []).every((n) => !/could not be re-expanded/.test(n)),
      'no un-expandable module rollup remains',
    );
    // The binding b carries a re-resolvable SymbolId (the whole point) that chains.
    const bRow = (d.dependents?.['1'] ?? []).find((r) => r.name === 'b');
    if (bRow === undefined) throw new Error('b dependent missing');
    assert.ok(
      bRow.id.startsWith('ts:') && bRow.id.includes('b@src/b.ts'),
      'b rolled up to a re-resolvable binding id, not the module node',
    );
    const chained = await p.op('find_usages', { symbol: bRow.id });
    assert.ok('result' in chained && chained.result.ok, 'b’s id resolves on its own');
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
