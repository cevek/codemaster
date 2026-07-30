// t-162650 — the two ways the fanned scan can NARROW ITSELF and then claim completeness anyway. Both
// were live defects found by adversarial review after the fan landed, and both are invisible to the
// fan and vocabulary suites, so they get their own file (and the 300-line cap forces it anyway).
//
//   1. the fallback-only floor deduped against the POST-path-filter set, so a file a real tsconfig
//      covers but the CALLER's glob excluded was reported as "covered by NO tsconfig" — a false cause
//      with an inert remedy, which also forced `complete:false` on every scoped call;
//   2. a program the per-program `resolve` skipped appeared in no coverage field at all, so the answer
//      still said `complete` and printed the assignability verdict over a fan it had silently reduced —
//      the t-162650 shape returning through another door.
//
// The oracle in both is the fixture's construction: the repo DECLARES which tsconfig covers which
// file, so "covered by no tsconfig" is checkable against the repo rather than against another
// codemaster answer.

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

function dataOf(r: OpResult): ScanData {
  assert.ok('result' in r && r.result.ok, JSON.stringify(r));
  return r.result.data as ScanData;
}

const files = (d: ScanData): string[] => (d.sites ?? []).map((s) => s.span.file).sort();
const notes = (d: ScanData): string => (d.notes ?? []).join('\n');

test('the fallback-only floor must not blame a missing tsconfig for a file the CALLER excluded', async () => {
  // BLOCK (bug-review): the unclaimed count was deduped against the POST-path-filter set, so on a
  // no-root repo any file the caller's own glob removed was reported as "covered by NO tsconfig" —
  // both halves false (a real config covers it) and its remedy ("add a tsconfig") inert. It also
  // forced `complete:false` on every scoped call, suppressing the verdict the scan had earned.
  const p: TestProject = await project({
    // No ROOT tsconfig → the no-config fallback primary is live and gets excluded as an authority.
    'pkg/tsconfig.json': `{"compilerOptions":${STRICT},"include":["."]}`,
    'pkg/package.json': '{"name":"pkg","version":"0.0.0"}',
    'pkg/type.ts': 'export interface Cfg { id: string; flag: boolean }\n',
    'pkg/a.ts':
      "import type { Cfg } from './type';\nexport const a: Cfg = { id: 'a', flag: true };\n",
    'pkg/b.ts':
      "import type { Cfg } from './type';\nexport const b: Cfg = { id: 'b', flag: false };\n",
  });
  try {
    const data = dataOf(
      await p.op('construction_sites', { name: 'Cfg', pathInclude: ['pkg/a.ts'] }),
    );
    assert.deepEqual(files(data), ['pkg/a.ts'], 'the scoped call answers within its scope');
    const n = notes(data);
    // `pkg/b.ts` IS covered by pkg/tsconfig.json — the caller's glob removed it, nothing else.
    assert.ok(
      !/covered by NO tsconfig/.test(n),
      `a caller-excluded file must not be reported as covered by no tsconfig: ${n}`,
    );
    assert.ok(
      !/Add a tsconfig covering/.test(n),
      `and must not be given an inert "add a tsconfig" remedy: ${n}`,
    );
  } finally {
    await p.dispose();
  }
});

test('a fanned program whose own options make T uncheckable is DISCLOSED, never silently dropped', async () => {
  // BLOCK (bug-review): a program skipped by the per-program `resolve` appeared in no coverage field
  // at all, so `scanCompleteness` still said `complete` and the answer printed "the scan was
  // COMPLETE, so this is a verdict" over a fan it had silently narrowed — the t-162650 shape
  // returning through another door.
  //
  // The sibling's `paths` redirect `./type` to a DIFFERENT declaration where `Cfg` is `unknown` — a
  // vacuous target under that program's own options, which the fan must skip (judging its files
  // against a top type would flood every literal in as a build of T).
  const LAX = '{"strict":true,"module":"esnext","moduleResolution":"bundler"}';
  const p: TestProject = await project({
    'tsconfig.json': `{"compilerOptions":${LAX},"include":["src"]}`,
    'tsconfig.alt.json': `{"compilerOptions":{"strict":true,"module":"esnext","moduleResolution":"bundler","baseUrl":".","paths":{"*":["stub/*","*"]}},"include":["src","alt"]}`,
    'src/type.ts': 'export interface Cfg { id: string; flag: boolean }\n',
    'src/use.ts':
      "import type { Cfg } from './type';\nexport const inSrc: Cfg = { id: 'a', flag: true };\n",
    'alt/other.ts': 'export const other = { id: 1 };\n',
  });
  try {
    const data = dataOf(await p.op('construction_sites', { name: 'Cfg' }));
    const scanned = (data.programsScanned ?? []).join('\n');
    const n = notes(data);
    // Whatever the fan did, the two claims must agree: it may report `complete` only if it scanned
    // every program it held. If any program is missing from the scope, the answer must say so.
    const fanHeldBoth = /tsconfig\.json:/.test(scanned) && /tsconfig\.alt\.json:/.test(scanned);
    if (!fanHeldBoth) {
      assert.equal(data.complete, false, `a narrowed fan may not claim completeness: ${scanned}`);
      assert.match(n, /program\(s\) in the fan were NOT scanned/, 'the skip is named');
      assert.ok(
        !/scan was COMPLETE/.test(n),
        `a narrowed fan must not print the assignability verdict: ${n}`,
      );
    }
  } finally {
    await p.dispose();
  }
});
