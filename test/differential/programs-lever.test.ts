// The `programs:` per-call lever (t-228533), oracle-backed (§16). An agent can widen a READ over an
// otherwise-UNDISCOVERED nested tsconfig by naming it — recovering a complete count / certain
// dead-code verdict without editing the repo. The lever injects the requested config into the SAME
// `computeCoverage` machinery, so the covered-vs-floored verdict is the ONE correct-resolution proof:
//   (1) find_usages: a usage only under an undiscovered nested config is FOUND + the floor lifts;
//   (4) find_unused_exports: a genuinely-dead export reads `certain` again over the loaded config;
//   (5) importers_of: an importer only under the nested config is found;
//   (2) ANTI-LIE DISCRIMINATOR: a partial-coverage MEMBER (an un-injectable `declare global` stray
//       under it) STAYS floored (reported programsFloored, NOT subtracted) — a coarse `fileNames()>0`
//       gate would falsely lift it and read a stray-only-used export as certain-dead (the never-lie
//       violation t-232769/t-851482 closed; this keeps it closed through the user-facing arg);
//   (3) a not-found path is reported honestly, never a phantom subtraction.
// Oracle: a fresh-from-cold `ts.LanguageService` over the nested config (a DIFFERENT program than the
// warm daemon composes), so a cross-program drift would surface.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { project, type TestProject } from '../helpers/project.ts';
import { coldFindReferences } from '../helpers/cold-ls.ts';
import type { OpResult } from '../../src/ops/contracts.ts';

const C = '{"strict":true,"module":"esnext","moduleResolution":"bundler"}';

type Usage = { span: { file: string; line: number; col: number }; role: string };
type UsagesData = {
  usages?: Usage[];
  complete?: boolean;
  undiscoveredPrograms?: string[];
  programsLoaded?: string[];
  programsFloored?: string[];
  programsNotFound?: string[];
  notes?: string[];
};
function usagesData(r: OpResult): UsagesData {
  assert.ok('result' in r && r.result.ok, JSON.stringify(r));
  return r.result.data as UsagesData;
}
const fileSet = (u: Usage[]): string[] => [...new Set(u.map((x) => x.span.file))].sort();

type UnusedRow = { name: string; confidence: string };
type UnusedData = {
  unused: UnusedRow[];
  undiscoveredPrograms?: string[];
  programsLoaded?: string[];
  programsFloored?: string[];
};
function unusedData(r: OpResult): UnusedData {
  assert.ok('result' in r && r.result.ok, JSON.stringify(r));
  return r.result.data as UnusedData;
}

test('(1) find_usages: programs: loads an undiscovered nested config → usage found + floor lifts', async () => {
  const p: TestProject = await project({
    'tsconfig.json': `{"compilerOptions":${C},"include":["src"]}`,
    'src/lib.ts': 'export const shared = 1;\n',
    // nested/ is NOT adjacent to the primary, NOT referenced, NO workspace manifest → UNDISCOVERED.
    'nested/tsconfig.json': `{"compilerOptions":${C},"include":["."]}`,
    'nested/app.ts': "import { shared } from '../src/lib';\nexport const x = shared + 1;\n",
  });
  try {
    // Baseline: floored, and the nested usage is NOT found (nested program not loaded).
    const before = usagesData(
      await p.op('find_usages', { name: 'shared', collapseImports: false }),
    );
    assert.equal(before.complete, false, 'floored before the lever');
    assert.ok(
      (before.undiscoveredPrograms ?? []).includes('nested/tsconfig.json'),
      `nested config floored: ${JSON.stringify(before.undiscoveredPrograms)}`,
    );
    assert.ok(
      !fileSet(before.usages ?? []).includes('nested/app.ts'),
      'the nested usage is unseen before the lever',
    );

    // With programs: the nested config loads → usage found + floor lifts.
    const after = usagesData(
      await p.op('find_usages', {
        name: 'shared',
        collapseImports: false,
        programs: ['nested/tsconfig.json'],
      }),
    );
    assert.notEqual(after.complete, false, 'floor lifts once the config is loaded');
    assert.deepEqual(after.undiscoveredPrograms ?? [], [], 'no floor after the lever');
    assert.deepEqual(after.programsLoaded, ['nested/tsconfig.json']);
    assert.equal(after.programsFloored, undefined);
    const u = after.usages ?? [];
    assert.ok(fileSet(u).includes('nested/app.ts'), `nested usage found: ${JSON.stringify(u)}`);

    // Oracle: a cold LS over nested/tsconfig.json (its program pulls in src/lib.ts via the import).
    const oracle = coldFindReferences(p.root, 'src/lib.ts', 'shared', 'nested/tsconfig.json');
    assert.deepEqual(fileSet(u), oracle, 'warm+lever fan-out matches the cold nested oracle');
  } finally {
    await p.dispose();
  }
});

test('(4) find_unused_exports: programs: recovers a `certain` verdict over an undiscovered config', async () => {
  const p: TestProject = await project({
    'tsconfig.json': `{"compilerOptions":${C},"include":["src"]}`,
    'src/lib.ts': 'export const usedFromNested = 1;\nexport const trulyDead = 2;\n',
    'nested/tsconfig.json': `{"compilerOptions":${C},"include":["."]}`,
    'nested/app.ts':
      "import { usedFromNested } from '../src/lib';\nexport const y = usedFromNested;\n",
  });
  try {
    // Baseline: floored → every otherwise-certain claim demoted to partial.
    const before = unusedData(await p.op('find_unused_exports', {}));
    assert.ok((before.undiscoveredPrograms ?? []).includes('nested/tsconfig.json'));
    const deadBefore = before.unused.find((x) => x.name === 'trulyDead');
    assert.ok(deadBefore && deadBefore.confidence === 'partial', 'demoted while floored');

    // With programs: the floor lifts → trulyDead reads certain, and usedFromNested is NOT dead
    // (its nested usage is now searched, never falsely reported).
    const after = unusedData(
      await p.op('find_unused_exports', { programs: ['nested/tsconfig.json'] }),
    );
    assert.deepEqual(after.undiscoveredPrograms ?? [], [], 'floor lifted');
    assert.deepEqual(after.programsLoaded, ['nested/tsconfig.json']);
    const dead = after.unused.find((x) => x.name === 'trulyDead');
    assert.ok(dead && dead.confidence === 'certain', `trulyDead certain: ${JSON.stringify(dead)}`);
    assert.ok(
      !after.unused.some((x) => x.name === 'usedFromNested'),
      'the nested-used export is NOT reported dead',
    );
  } finally {
    await p.dispose();
  }
});

test('(2) ANTI-LIE: a partial-coverage member (un-injectable stray) STAYS floored, never subtracted', async () => {
  // pkg is a workspace member with `include:["src"]` and an un-injectable `declare global` stray
  // (`globals.ts`) that imports a src export. The stray CANNOT be injected (it would shift the
  // member's own src types — never-lie §3), so `deadish`'s only usage (in the stray) is unsearched →
  // the member MUST stay floored and `deadish` MUST stay `partial`. A coarse `fileNames()>0` gate
  // would see the member's src files, subtract it, and read `deadish` as certain-dead — the exact lie.
  const p: TestProject = await project({
    'pnpm-workspace.yaml': "packages:\n  - 'packages/*'\n",
    'package.json': '{"name":"root","private":true}',
    'packages/pkg/package.json': '{"name":"pkg"}',
    'packages/pkg/tsconfig.json': `{"compilerOptions":${C},"include":["src"]}`,
    'packages/pkg/src/index.ts': 'export const alive = 1;\nexport const deadish = 2;\n',
    // Un-injectable stray under the member dir, outside include:["src"]: imports deadish.
    'packages/pkg/globals.ts':
      "declare global { interface Window { __x: number } }\nimport { deadish } from './src/index';\nexport const g = deadish;\n",
  });
  try {
    const before = unusedData(await p.op('find_unused_exports', {}));
    assert.ok(
      (before.undiscoveredPrograms ?? []).includes('packages/pkg/tsconfig.json'),
      `member floored by the un-injectable stray: ${JSON.stringify(before.undiscoveredPrograms)}`,
    );

    // programs: on the SAME member must NOT lift the floor — it stays floored (partial coverage).
    const after = unusedData(
      await p.op('find_unused_exports', { programs: ['packages/pkg/tsconfig.json'] }),
    );
    assert.ok(
      (after.programsFloored ?? []).includes('packages/pkg/tsconfig.json'),
      `reported programsFloored, NOT loaded: ${JSON.stringify(after)}`,
    );
    assert.ok(
      !(after.programsLoaded ?? []).includes('packages/pkg/tsconfig.json'),
      'a partial-coverage member is NEVER reported programsLoaded',
    );
    assert.ok(
      (after.undiscoveredPrograms ?? []).includes('packages/pkg/tsconfig.json'),
      'the undiscovered floor stays intact',
    );
    // deadish's only use is in the un-injectable stray → it must NOT read certain-dead.
    const deadish = after.unused.find((x) => x.name === 'deadish');
    assert.ok(
      deadish === undefined || deadish.confidence !== 'certain',
      `deadish must never be certain-dead (its stray usage is unsearched): ${JSON.stringify(deadish)}`,
    );
  } finally {
    await p.dispose();
  }
});

test('(8) ANTI-CONTRADICTION: a programs:-named EMPTY-glob config stays floored consistently (no self-contradiction)', async () => {
  // An empty-glob nested config (include matches nothing) covers NOTHING → coverage keeps it floored.
  // It is ALSO the nearest config of a searched file, so the file-driven read path would otherwise load
  // it and LOOSELY subtract it from the floor — while classifyPrograms (coverage-gated) reports it
  // `programsFloored`. That split is a self-contradictory floor verdict (§1/§3 never-lie). The lever must
  // keep an explicitly-named config's floor decision on the coverage proof: floored HERE and in the
  // report, never one-of-each.
  const p: TestProject = await project({
    // Primary globs everything (so nestedSym resolves), incl. the file under nested/.
    'tsconfig.json': `{"compilerOptions":${C},"include":["."]}`,
    'nested/tsconfig.json': `{"compilerOptions":${C},"include":["./does-not-exist"]}`,
    'nested/decl.ts': 'export const nestedSym = 1;\n',
  });
  try {
    // Call 1 (NO programs:): the read primes the file-driven map with the empty config (it is the
    // nearest config of nested/decl.ts) — the state where the two floor paths could later disagree.
    await p.op('find_usages', { name: 'nestedSym', collapseImports: false });
    // Call 2 (WITH programs:): the same config is now in BOTH the file-driven and explicit maps.
    const d = usagesData(
      await p.op('find_usages', {
        name: 'nestedSym',
        collapseImports: false,
        programs: ['nested/tsconfig.json'],
      }),
    );
    assert.ok(
      (d.programsFloored ?? []).includes('nested/tsconfig.json'),
      `an empty-glob config is reported floored (covers nothing): ${JSON.stringify(d)}`,
    );
    // The FLOOR must AGREE with the report — never subtracted by the looser file-driven path.
    assert.ok(
      (d.undiscoveredPrograms ?? []).includes('nested/tsconfig.json'),
      `floor agrees with programsFloored — no self-contradiction: ${JSON.stringify(d.undiscoveredPrograms)}`,
    );
    assert.notEqual(d.programsLoaded?.includes('nested/tsconfig.json'), true);
  } finally {
    await p.dispose();
  }
});

test('(3) programs: a not-found path is reported honestly, never a phantom subtraction', async () => {
  const p: TestProject = await project({
    'tsconfig.json': `{"compilerOptions":${C},"include":["src"]}`,
    'src/lib.ts': 'export const shared = 1;\n',
    'nested/tsconfig.json': `{"compilerOptions":${C},"include":["."]}`,
    'nested/app.ts': "import { shared } from '../src/lib';\nexport const x = shared;\n",
  });
  try {
    const d = usagesData(
      await p.op('find_usages', {
        name: 'shared',
        collapseImports: false,
        programs: ['nested/tsconfig.json', 'does/not/exist/tsconfig.json'],
      }),
    );
    assert.deepEqual(d.programsLoaded, ['nested/tsconfig.json']);
    assert.deepEqual(d.programsNotFound, ['does/not/exist/tsconfig.json']);
    // The real one still lifts the floor; the bogus one does not fabricate coverage.
    assert.deepEqual(d.undiscoveredPrograms ?? [], []);
  } finally {
    await p.dispose();
  }
});

test('(5) importers_of: programs: finds an importer only under an undiscovered nested config', async () => {
  const p: TestProject = await project({
    'tsconfig.json': `{"compilerOptions":${C},"include":["src"]}`,
    'src/lib.ts': 'export const shared = 1;\n',
    'nested/tsconfig.json': `{"compilerOptions":${C},"include":["."]}`,
    'nested/app.ts': "import { shared } from '../src/lib';\nexport const x = shared;\n",
  });
  try {
    type ImpData = {
      importers?: { at: string }[];
      total?: number;
      complete?: boolean;
      undiscoveredPrograms?: string[];
      programsLoaded?: string[];
    };
    const imp = (r: OpResult): ImpData => {
      assert.ok('result' in r && r.result.ok, JSON.stringify(r));
      return r.result.data as ImpData;
    };
    const before = imp(await p.op('importers_of', { module: 'src/lib.ts' }));
    assert.ok(
      (before.undiscoveredPrograms ?? []).includes('nested/tsconfig.json'),
      'floored before the lever',
    );

    const after = imp(
      await p.op('importers_of', { module: 'src/lib.ts', programs: ['nested/tsconfig.json'] }),
    );
    assert.deepEqual(after.programsLoaded, ['nested/tsconfig.json']);
    assert.deepEqual(after.undiscoveredPrograms ?? [], []);
    assert.ok(
      (after.importers ?? []).some((r) => r.at.startsWith('nested/app.ts')),
      `the nested importer is found: ${JSON.stringify(after.importers)}`,
    );
  } finally {
    await p.dispose();
  }
});
