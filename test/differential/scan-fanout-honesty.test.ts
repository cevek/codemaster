// t-162650 — the type-anchored SCANNING ops (`construction_sites` / `discrimination_sites`) walked
// ONE program, so a site living in a sibling program came back as a confident `0` whose note read as
// a semantic verdict ("no object literal is assignable to T") and whose remedy blamed the caller's
// `pathInclude` — the one lever that cannot add a program. These tests pin the fix in both
// directions: the fan must FIND the sibling site, and it must never LAUNDER one program's verdict
// through another program's checker.
//
// Oracles (§16 — a fixture is input, never proof):
//   · the fixture DECLARES which sites exist, and under WHICH compilerOptions each is assignable
//     (the primary is `strict`, the sibling is not — a difference tsc itself decides, not us);
//   · `coldAssignableLiterals` over the SIBLING config is an independent cold `ts.Program` that
//     confirms the cross-program ground truth the warm fan claims.
// The negative arm is the load-bearing one: a fan that reused ONE target type across every
// program's files would report the strict-program literal as a site and go RED here, which no
// positive assertion about the sibling site can catch.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { project, type TestProject } from '../helpers/project.ts';
import { coldAssignableLiterals } from '../helpers/cold-ls.ts';
import type { OpResult } from '../../src/ops/contracts.ts';

type Site = { span: { file: string; line: number } };
type ScanData = {
  complete?: false;
  programsScanned?: string[];
  undiscoveredPrograms?: string[];
  sites?: Site[];
  scanned?: { literals?: number; statements?: number; files: number };
  notes?: string[];
};

const STRICT = '{"strict":true,"module":"esnext","moduleResolution":"bundler"}';

/** A src-declared type with a construction site in src AND one only in the test program. */
const CROSS = {
  'tsconfig.json': `{"compilerOptions":${STRICT},"include":["src"]}`,
  'tsconfig.test.json': `{"compilerOptions":${STRICT},"include":["src","test"]}`,
  'src/type.ts': 'export interface Cfg { id: string; flag: boolean }\n',
  'src/use.ts':
    "import type { Cfg } from './type';\nexport const inSrc: Cfg = { id: 'a', flag: true };\n",
  'test/use.test.ts':
    "import type { Cfg } from '../src/type';\n" +
    "export const inTest: Cfg = { id: /*SITE*/ 'b', flag: false };\n",
};

/** Two programs whose compilerOptions DISAGREE about one literal: `{ id: null }` is assignable to
 *  `{ id: string }` only with `strictNullChecks` OFF. The strict primary owns `src/**`, the lax
 *  sibling owns `lax/**` — so each file's verdict must come from ITS OWN program. */
const DIVERGENT = {
  'tsconfig.json': `{"compilerOptions":${STRICT},"include":["src"]}`,
  'tsconfig.lax.json':
    '{"compilerOptions":{"strict":false,"module":"esnext","moduleResolution":"bundler"},"include":["src","lax"]}',
  'src/type.ts': 'export interface Cfg { id: string }\n',
  // Assignable ONLY under the lax options — the strict primary owns this file, so it is NOT a site.
  'src/loose.ts': 'export const strictProbe = { id: null };\n',
  // Owned by the lax program alone — assignable under ITS options, so it IS a site.
  'lax/only.ts': 'export const laxProbe = { id: null };\n',
};

function dataOf(r: OpResult): ScanData {
  assert.ok('result' in r && r.result.ok, JSON.stringify(r));
  return r.result.data as ScanData;
}

const files = (d: ScanData): string[] => (d.sites ?? []).map((s) => s.span.file).sort();
const notes = (d: ScanData): string => (d.notes ?? []).join('\n');

test('construction_sites fans across programs: a test-only construction site is FOUND, and the scope is stated per program', async () => {
  const p: TestProject = await project(CROSS);
  try {
    // Independent cold oracle over the SIBLING config — the cross-program ground truth.
    const oracle = coldAssignableLiterals(p.root, 'src/type.ts', 'Cfg', 'tsconfig.test.json');
    assert.ok(
      oracle.some((o) => o.file === 'test/use.test.ts'),
      'oracle: the test-program construction site exists',
    );

    const data = dataOf(await p.op('construction_sites', { name: 'Cfg' }));
    assert.deepEqual(
      files(data),
      ['src/use.ts', 'test/use.test.ts'],
      'both the primary and the sibling site are reported',
    );

    // The scope is POSITIVE and per-program: this is what stops a small `files=N` being read as
    // "scanned the repo" (the mis-diagnosis the single-program output invited).
    const scope = (data.programsScanned ?? []).join('\n');
    assert.match(scope, /tsconfig\.json:/, 'the primary program is named');
    assert.match(scope, /tsconfig\.test\.json:/, 'the sibling program is named');
  } finally {
    await p.dispose();
  }
});

test('a per-program verdict never leaks across programs: the strict-only literal is NOT a site, the lax-only one IS', async () => {
  const p: TestProject = await project(DIVERGENT);
  try {
    // Oracle: the two configs genuinely disagree, so this fixture can discriminate at all.
    const strictOracle = coldAssignableLiterals(p.root, 'src/type.ts', 'Cfg', 'tsconfig.json');
    const laxOracle = coldAssignableLiterals(p.root, 'src/type.ts', 'Cfg', 'tsconfig.lax.json');
    assert.ok(
      !strictOracle.some((o) => o.file === 'src/loose.ts'),
      'oracle: under strict options `{id:null}` is NOT assignable',
    );
    assert.ok(
      laxOracle.some((o) => o.file === 'src/loose.ts'),
      'oracle: under lax options the SAME literal IS assignable — the configs disagree',
    );

    const data = dataOf(await p.op('construction_sites', { name: 'Cfg' }));
    const got = files(data);
    // The load-bearing negative: `src/loose.ts` is owned by the STRICT primary, so the lax
    // program's "yes" must not reach it. A fan that shared one target type across all files, or
    // let the lax sibling claim a src file, reports it here.
    assert.ok(
      !got.includes('src/loose.ts'),
      `a strict-program file judged by lax options leaked in: ${JSON.stringify(got)}`,
    );
    assert.ok(
      got.includes('lax/only.ts'),
      `the sibling-owned file must be judged by its OWN program: ${JSON.stringify(got)}`,
    );
  } finally {
    await p.dispose();
  }
});

test('an EMPTY SCAN is not a verdict: 0 files scanned says so outright and never asserts assignability', async () => {
  const p: TestProject = await project(CROSS);
  try {
    const data = dataOf(
      await p.op('construction_sites', { name: 'Cfg', pathInclude: ['nowhere/**'] }),
    );
    assert.deepEqual(files(data), [], 'nothing was found');
    assert.equal(data.scanned?.files, 0, 'and nothing was scanned');
    const n = notes(data);
    assert.match(n, /NOT A VERDICT/, 'the emptiness is labelled as an empty SCAN');
    assert.ok(
      !/is assignable to/.test(n),
      `an unscanned answer must not render an assignability verdict: ${n}`,
    );
    // The remedy names the lever that CAN change the outcome, with the count that proves it is the
    // filter and not the program set (t-259465: never a lever that cannot help).
    assert.match(n, /matched 0 of the \d+ file/, 'the glob is named as the cause, with counts');
  } finally {
    await p.dispose();
  }
});

test('a COMPLETE empty scan states a verdict and does NOT blame pathInclude (an inert lever)', async () => {
  const p: TestProject = await project({
    'tsconfig.json': `{"compilerOptions":${STRICT},"include":["src"]}`,
    'src/type.ts': 'export interface Unbuilt { onlyField: string; other: number }\n',
    'src/other.ts': 'export const unrelated = { somethingElse: 1 };\n',
  });
  try {
    const data = dataOf(await p.op('construction_sites', { name: 'Unbuilt' }));
    assert.deepEqual(files(data), [], 'nothing builds it');
    const n = notes(data);
    assert.match(n, /scan was COMPLETE/, 'a complete scan may state a verdict');
    assert.ok(
      !/pathInclude/.test(n),
      `a complete scan is complete whatever the glob was — naming it is an inert remedy: ${n}`,
    );
    assert.equal(data.complete, undefined, 'a complete scan carries no `complete:false`');
  } finally {
    await p.dispose();
  }
});

test('a spent BUDGET is a different fact from an unloaded config — its note names the budget, not indexing', async () => {
  const p: TestProject = await project(CROSS);
  try {
    const data = dataOf(await p.op('construction_sites', { name: 'Cfg', limit: 1 }));
    assert.equal(data.complete, false, 'a truncated scan is not complete');
    const n = notes(data);
    assert.match(n, /the shortfall is the budget, NOT a missing config/, 'the cause is the budget');
    assert.ok(
      !/NOT loaded as programs/.test(n),
      `this fixture has no undiscovered config — that vocabulary must not fire: ${n}`,
    );
  } finally {
    await p.dispose();
  }
});

test('discrimination_sites fans across programs: a test-only switch on a src union is FOUND', async () => {
  const p: TestProject = await project({
    'tsconfig.json': `{"compilerOptions":${STRICT},"include":["src"]}`,
    'tsconfig.test.json': `{"compilerOptions":${STRICT},"include":["src","test"]}`,
    'src/shape.ts':
      "export type Shape = { kind: 'circle'; r: number } | { kind: 'square'; side: number };\n",
    'src/area.ts':
      "import type { Shape } from './shape';\n" +
      'export function area(s: Shape): number {\n' +
      "  switch (s.kind) { case 'circle': return s.r; case 'square': return s.side; }\n" +
      '}\n',
    'test/shape.test.ts':
      "import type { Shape } from '../src/shape';\n" +
      'export function label(s: Shape): string {\n' +
      "  switch (s.kind) { case 'circle': return 'c'; default: return 's'; }\n" +
      '}\n',
  });
  try {
    const data = dataOf(await p.op('discrimination_sites', { name: 'Shape' }));
    assert.deepEqual(
      files(data),
      ['src/area.ts', 'test/shape.test.ts'],
      'the sibling-program switch is reported alongside the primary one',
    );
    const scope = (data.programsScanned ?? []).join('\n');
    assert.match(scope, /tsconfig\.test\.json:/, 'the sibling program is named in the scope');
  } finally {
    await p.dispose();
  }
});
