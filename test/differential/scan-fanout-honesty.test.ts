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
    // Arm 1 — CLAIMING: `src/loose.ts` is owned by the STRICT primary, so the lax program's "yes"
    // must not reach it. Red if the lax sibling claimed a src file, or if the primary's target type
    // were checked against the lax program's files.
    assert.ok(
      !got.includes('src/loose.ts'),
      `a strict-program file judged by lax options leaked in: ${JSON.stringify(got)}`,
    );
    const laxSite = (data.sites ?? []).find((s) => s.span.file === 'lax/only.ts');
    assert.ok(
      laxSite !== undefined,
      `the sibling-owned file must be judged by its OWN program: ${JSON.stringify(got)}`,
    );
    // Arm 2 — PER-PROGRAM RESOLVE, and this is what the presence check alone cannot catch. A fan
    // that hoisted ONE `resolve` would still LIST this site: judging a lax-program node with the
    // strict checker yields an error/`any` type, which `classifyConstructionSite` reports as a
    // `dynamic` site ("the literal's type is `any`"). Under a correct per-program resolve the literal
    // is concrete, non-generic and has no `any` member → `certain`. The CONFIDENCE is the
    // discriminator, not the row.
    assert.equal(
      laxSite.confidence,
      'certain',
      `the sibling site must be judged by its own checker (a foreign checker degrades it to dynamic): ${JSON.stringify(laxSite)}`,
    );
  } finally {
    await p.dispose();
  }
});
