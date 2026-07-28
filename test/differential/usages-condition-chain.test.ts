// `find_usages {conditions:true}` — the per-site enclosing-condition chain (t-933867).
//
// ORACLE 1 of three, plus the output pins. The failure mode is a WRONG FACT about the code, not mere
// incompleteness — a swapped then/else reports a site as guarded by the condition that actually
// EXCLUDES it (§3 never-lie) — so what each oracle can and cannot discriminate is stated, not assumed:
//   1. HERE — the fixture (`condition-cases.ts`): every site is written with the chain it sits under,
//      by construction. Catches a wrong chain for any shape SOMEBODY THOUGHT OF, which is also its
//      limit: an unlisted shape is simply absent, so that case table IS the coverage.
//   2. usages-condition-descent.test.ts — the same rules top-down from a fresh parse. Discriminates
//      MECHANICS (a lost level, a bad reversal, a missed site), NOT a wrong rule.
//   3. usages-condition-runtime.test.ts — EXECUTION: a site fires ⟺ its reported chain evaluates
//      true. The decisive one; it cannot share a misconception with the implementation.
// This file also pins the two OUTPUT faces of the fact: the dense line here, the sql column in
// test/e2e/sql-absence-audit.test.ts.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { project } from '../helpers/project.ts';
import { renderResult } from '../../src/format/render/render-result.ts';
import { FILES, expectedByLine, opChains } from '../fixtures/inline/condition-cases.ts';

test('oracle 1 (fixture): every site carries the chain it was written under, polarity included', async () => {
  const { rows, dispose } = await opChains();
  try {
    const expected = expectedByLine();
    // Guard the guard (the runtime oracle's lesson applied here): if the case filter stops matching —
    // a renamed `F`, a new call shape, a reference in type position — the loop below becomes empty and
    // this test passes having asserted NOTHING.
    //
    // A size floor alone is not enough: set at the count that existed BEFORE the type-position cases
    // were admitted, it tolerates exactly the regression it was written for. So the shapes whose ONLY
    // pin is this table are named outright.
    assert.ok(expected.size > 0, 'the case table went silent — the filter matches nothing');
    for (const marker of ['typeof F', '(o.m?.g).call', 'o.m?.g!.call', 'o.m?.g?.(']) {
      assert.ok(
        [...expected.values()].some((c) => c.code.includes(marker)),
        `'${marker}' dropped out of the oracle — it is the ONLY pin for its rule`,
      );
    }
    for (const [line, c] of expected) {
      const row = rows.find((x) => x.line === line);
      assert.ok(row !== undefined, `no usage reported on line ${line}: ${c.code}`);
      assert.deepEqual(row.conditions, c.conditions, `chain on line ${line}: ${c.code}`);
      assert.equal(row.partial, c.partial === true, `partial flag on line ${line}: ${c.code}`);
    }
    // The import specifier is a reference too, and it sits under nothing — a MEASURED empty chain,
    // present rather than absent (absent would mean "not annotated").
    const importRow = rows.find((x) => x.line === 1);
    assert.ok(importRow !== undefined, 'the import-site reference is annotated too');
    assert.deepEqual(importRow.conditions, []);
  } finally {
    await dispose();
  }
});

test('the dense line carries the chain, the measured-empty token, and the subset marker', async () => {
  // The sql column is pinned in test/e2e/sql-absence-audit.test.ts; this pins the OTHER face — the
  // default text render an agent actually reads (the two spellings of the empty chain are the one
  // place the faces differ by design, so both must be observed, not inferred).
  const p = await project(FILES);
  try {
    const r = await p.op('find_usages', { name: 'F', conditions: true, limit: 500 });
    assert.ok('result' in r && r.result.ok);
    const text = renderResult(r.result, 'terse');
    assert.ok(text.includes('⟨x⟩'), `a stated chain must render: ${text.slice(0, 400)}`);
    assert.ok(text.includes('⟨no branch⟩'), 'the MEASURED empty chain renders as its own token');
    assert.ok(
      text.includes('⟨<unstated>⟩'),
      'a site under only an unstated branch (default:/catch) renders the subset marker',
    );
    assert.ok(!text.includes('⟨⟩'), 'never a bare ⟨⟩ — that would read as a render glitch');
  } finally {
    await p.dispose();
  }
});

test('over the chain cap: the INNERMOST conditions are kept and the drop is disclosed', async () => {
  // Five nested branches, four reportable: the nearest ones are the load-bearing ones, and the
  // dropped outer ones must surface as `partial` — a silently shortened chain would read as the
  // whole guard set (§3.4).
  const p = await project({
    'tsconfig.json': '{"compilerOptions":{"strict":true}}',
    'src/f.ts': 'export const F = (): boolean => true;\n',
    'src/deep.ts':
      `import { F } from './f';\n` +
      `export function d(a: boolean, b: boolean, c: boolean, e: boolean, g: boolean): void {\n` +
      `  if (a) { if (b) { if (c) { if (e) { if (g) { F(); } } } } }\n}\n`,
  });
  try {
    const r = await p.op('find_usages', { name: 'F', conditions: true, limit: 50 });
    assert.ok('result' in r && r.result.ok);
    const view = r.result.data as {
      usages: {
        span: { file: string };
        condition?: { conditions?: string[]; partial?: true };
      }[];
    };
    const site = view.usages.find((u) => u.span.file === 'src/deep.ts');
    assert.ok(site?.condition !== undefined, 'the deep site is annotated');
    assert.deepEqual(
      site.condition.conditions,
      ['b', 'c', 'e', 'g'],
      'innermost four kept, in order',
    );
    assert.equal(site.condition.partial, true, 'the dropped outer condition is disclosed');
  } finally {
    await p.dispose();
  }
});

test('a long predicate is elided with a visible marker, never silently cut', async () => {
  const long = `someVeryLongPredicateName${'X'.repeat(80)}`;
  const p = await project({
    'tsconfig.json': '{"compilerOptions":{"strict":true}}',
    'src/f.ts': 'export const F = (): boolean => true;\n',
    'src/long.ts':
      `import { F } from './f';\n` +
      `export function l(${long}: boolean): void {\n  if (${long}) { F(); }\n}\n`,
  });
  try {
    const r = await p.op('find_usages', { name: 'F', conditions: true, limit: 50 });
    assert.ok('result' in r && r.result.ok);
    const view = r.result.data as {
      usages: { span: { file: string }; condition?: { conditions?: string[] } }[];
    };
    const site = view.usages.find((u) => u.span.file === 'src/long.ts');
    const cond = site?.condition?.conditions?.[0] ?? '';
    assert.ok(cond.endsWith('…'), `elision marker expected, got: ${cond}`);
    assert.ok(long.startsWith(cond.slice(0, -1)), 'the kept prefix is the real predicate text');
  } finally {
    await p.dispose();
  }
});

test('under groupBy the flag cannot apply — the rollup carries no chain, and says so', async () => {
  const p = await project(FILES);
  try {
    const r = await p.op('find_usages', {
      name: 'F',
      conditions: true,
      groupBy: 'enclosing',
      limit: 50,
    });
    assert.ok('result' in r && r.result.ok);
    const view = r.result.data as { groups?: Record<string, unknown>[]; notes?: string[] };
    for (const g of view.groups ?? []) {
      assert.ok(!('condition' in g), 'a rollup row must not carry a per-site chain');
    }
    assert.ok(
      (view.notes ?? []).some((n) => n.startsWith('conditions ignored')),
      `the ignored flag must be disclosed, notes: ${JSON.stringify(view.notes)}`,
    );
  } finally {
    await p.dispose();
  }
});
