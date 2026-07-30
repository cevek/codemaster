// t-162650 — the COVERAGE VOCABULARY of the type-anchored scans (`ops/scan-coverage.ts`): what an
// answer of `0` is allowed to claim, and which lever each shortfall names. Split from
// `scan-fanout-honesty.test.ts` (which pins the cross-program FAN itself) at the 300-line cap.
//
// The oracle is the fixture's own construction plus the honesty rule under test — each arm states a
// fact the repo makes true (this file is covered by that tsconfig; this walk opened no file) and then
// asserts the answer neither over- nor under-claims about it. Both directions are load-bearing: a
// complete scan dressed as partial is the same lie inverted (§3.6), so several arms assert the ABSENCE
// of a floor as hard as the others assert its presence.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { project, type TestProject } from '../helpers/project.ts';
import type { OpResult } from '../../src/ops/contracts.ts';

type Site = { span: { file: string; line: number }; confidence: string };
type ScanData = {
  complete?: false;
  programsScanned?: string[];
  programsSkipped?: string[];
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

function dataOf(r: OpResult): ScanData {
  assert.ok('result' in r && r.result.ok, JSON.stringify(r));
  return r.result.data as ScanData;
}

const files = (d: ScanData): string[] => (d.sites ?? []).map((s) => s.span.file).sort();
const notes = (d: ScanData): string => (d.notes ?? []).join('\n');

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

test('a COMPLETE scan that found no CANDIDATE still states a verdict — absence really was established', async () => {
  // The inverse lie the three-state gate exists to avoid (§3.6 "the same lie inverted"): `examined`
  // is 0 here not because nothing ran, but because the repo holds no object literal at all. A gate
  // keyed on `examined === 0` would print `!! NOT A VERDICT` over a finished walk.
  const p: TestProject = await project({
    'tsconfig.json': `{"compilerOptions":${STRICT},"include":["src"]}`,
    'src/type.ts': 'export interface Cfg { id: string }\n',
    'src/plain.ts': 'export const n = 1;\nexport function f(): number { return n + 1; }\n',
  });
  try {
    const data = dataOf(await p.op('construction_sites', { name: 'Cfg' }));
    assert.deepEqual(files(data), [], 'no sites');
    assert.equal(data.scanned?.literals, 0, 'and no candidate was examined');
    assert.ok((data.scanned?.files ?? 0) > 0, 'but files WERE walked');
    const n = notes(data);
    assert.match(n, /scan was COMPLETE/, 'a finished walk states its verdict');
    assert.ok(!/NOT A VERDICT/.test(n), `a finished walk is not an empty scan: ${n}`);
    assert.equal(data.complete, undefined, 'and carries no `complete:false`');
  } finally {
    await p.dispose();
  }
});

test('a NO-TSCONFIG repo: the fallback primary is disclosed as unsound rather than silently trusted', async () => {
  // Pins the fallback-primary branch of `selectScanFanout` (the t-593802 exclusion). Without a test
  // here, rewording the `(no tsconfig)` display label silently re-admits the whole-repo DEFAULT-options
  // program as a type authority — a verdict the project's own config never yields, reported as if it did.
  const p: TestProject = await project({
    'src/type.ts': 'export interface Cfg { id: string; flag: boolean }\n',
    'src/use.ts':
      "import type { Cfg } from './type';\nexport const inSrc: Cfg = { id: 'a', flag: true };\n",
  });
  try {
    const data = dataOf(await p.op('construction_sites', { name: 'Cfg' }));
    // It still ANSWERS (a refusal would be worse), and the site is found.
    assert.deepEqual(files(data), ['src/use.ts'], 'the fallback still answers');
    // But the answer says its options are not the project's, and is not marked complete.
    assert.equal(data.complete, false, 'a fallback-only scan is never `complete`');
    const n = notes(data);
    assert.match(n, /no-config fallback program/, 'the unsound-options caveat is stated');
    assert.match(
      (data.programsScanned ?? []).join('\n'),
      /\(no tsconfig\)/,
      'the scope names the fallback program explicitly',
    );
  } finally {
    await p.dispose();
  }
});

test('an expired budget: the PARTIAL note counts FILES, never claims a finished candidate sweep', async () => {
  // `opDeadlineMs: 0` is already expired under the frozen manual clock, so the walk breaks before
  // opening the first file (`common/async/deadline.ts`: "a non-positive budget is ALREADY expired —
  // the first poll degrades, which is exactly how a timeout test forces the path deterministically").
  //
  // The trap this pins: `candidates` is counted only INSIDE walked files, so after a cut
  // `examined of candidates` reads `0 of 0` — an exhausted sweep. Every shortfall statement must
  // therefore be denominated in FILES, the one unit that can express what was never opened.
  const p: TestProject = await project(CROSS, { opDeadlineMs: 0 });
  try {
    const r = await p.op('construction_sites', { name: 'Cfg' });
    assert.ok('result' in r, JSON.stringify(r));
    // Sites are real data, so an interrupted walk is `partial`, never `ok` (which reads as finished)
    // and never a bare `timeout` failure (which would throw real sites away).
    assert.equal(r.result.ok, false, 'an interrupted scan is not ok');
    assert.equal(r.result.failure?.tool, 'timeout');
    assert.equal(r.result.failure?.partial, true);
    const data = r.result.data as ScanData;
    const n = notes(data);
    assert.match(n, /PARTIAL SCAN/, 'the cut is disclosed');
    assert.match(n, /walking 0 of \d+ in-scope file\(s\)/, 'the shortfall is denominated in FILES');
    // The three fabrications the file-denominated counters exist to prevent.
    assert.ok(!/were walked across/.test(n), `must not claim files were walked: ${n}`);
    assert.ok(
      !/the shortfall is the budget/.test(n),
      `a deadline cut is not the limit budget — different cause, different remedy: ${n}`,
    );
    assert.ok(
      !/scan was COMPLETE/.test(n),
      `an interrupted scan must never state the assignability verdict: ${n}`,
    );
    // The scope is never SILENT about a fan the deadline emptied: whichever loop the cut landed in,
    // every program the fan held is accounted for — walked-of-claimed, or named as unscanned.
    const scope = [...(data.programsScanned ?? []), ...(data.programsSkipped ?? [])].join('\n');
    assert.match(
      scope,
      /0 of \d+ file\(s\) walked|NOT scanned: deadline/,
      `every fanned program must be accounted for: ${scope}`,
    );
  } finally {
    await p.dispose();
  }
});
