// Vacuous-filter honesty (T2, §3.4/§3.6): a `pathInclude`/`pathExclude` that matches ZERO
// files scans nothing, so `unused (0)` is NOT proof that no exports are dead — it is "nothing
// was examined". The op must surface a LOUD `filterMatchedNoFiles` warning so an agent never
// reads a vacuous scan as clean and acts on it. The honest whole-repo zero (no filter, really
// no dead exports) must NOT carry the warning. Oracle = a fixture whose file set is fixed by
// construction: a real dead export exists, so a 0-files result can ONLY mean the filter missed.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { project } from '../helpers/project.ts';

type Unused = { name: string; confidence: string };
type WarnView = {
  unused: Unused[];
  scanned: { exports: number; files: number };
  filterMatchedNoFiles?: string;
};

const FIXTURE = {
  'tsconfig.json': '{"compilerOptions":{"strict":true}}',
  'src/lib.ts': 'export const trulyDead = 1;\nexport const used = 2;\n',
  'src/app.ts': "import { used } from './lib';\nconsole.log(used);\n",
};

test('find_unused_exports: a pathInclude matching 0 files warns (NOT a false clean)', async () => {
  const p = await project(FIXTURE);
  try {
    const r = await p.op('find_unused_exports', { pathInclude: ['src/does-not-exist/**'] });
    assert.ok('result' in r && r.result.ok, 'op succeeds');
    const data = r.result.data as WarnView;
    assert.equal(data.scanned.files, 0, 'the bad glob matched no files');
    assert.ok(
      typeof data.filterMatchedNoFiles === 'string' && data.filterMatchedNoFiles.length > 0,
      'a vacuous filter raises the loud warning',
    );
    assert.match(
      data.filterMatchedNoFiles ?? '',
      /0 files/i,
      'the warning states the filter matched 0 files',
    );
    assert.match(
      data.filterMatchedNoFiles ?? '',
      /not proof/i,
      'the warning states this is NOT proof no exports are dead',
    );
  } finally {
    await p.dispose();
  }
});

test('find_unused_exports: a pathExclude alone that excludes everything also warns', async () => {
  const p = await project(FIXTURE);
  try {
    const r = await p.op('find_unused_exports', { pathExclude: ['src/**'] });
    assert.ok('result' in r && r.result.ok, 'op succeeds');
    const data = r.result.data as WarnView;
    assert.equal(data.scanned.files, 0, 'excluding the whole src left no files in scope');
    assert.ok(
      typeof data.filterMatchedNoFiles === 'string' && data.filterMatchedNoFiles.length > 0,
      'a pathExclude that zeroes the scope warns too',
    );
  } finally {
    await p.dispose();
  }
});

test('find_unused_exports: a filter matching REAL files raises no false warning', async () => {
  const p = await project(FIXTURE);
  try {
    const r = await p.op('find_unused_exports', { pathInclude: ['src/**'] });
    assert.ok('result' in r && r.result.ok, 'op succeeds');
    const data = r.result.data as WarnView;
    assert.ok(data.scanned.files > 0, 'real files were scanned');
    assert.equal(data.filterMatchedNoFiles, undefined, 'no warning when the filter matched files');
    // And it still finds the genuinely-dead export, so the scope is real, not vacuous.
    assert.equal(
      data.unused.find((u) => u.name === 'trulyDead')?.confidence,
      'certain',
      'the real dead export is found under a matching filter',
    );
  } finally {
    await p.dispose();
  }
});

test('find_unused_exports: an honest whole-repo zero carries no filter warning', async () => {
  // No filter, and every export is used → a legitimate `unused (0)` that must stay clean.
  const p = await project({
    'tsconfig.json': '{"compilerOptions":{"strict":true}}',
    'src/lib.ts': 'export const used = 1;\n',
    'src/app.ts': "import { used } from './lib';\nconsole.log(used);\n",
  });
  try {
    const r = await p.op('find_unused_exports', {});
    assert.ok('result' in r && r.result.ok, 'op succeeds');
    const data = r.result.data as WarnView;
    assert.equal(data.unused.length, 0, 'nothing dead');
    assert.equal(data.scanned.files, 2, 'the whole repo was scanned');
    assert.equal(
      data.filterMatchedNoFiles,
      undefined,
      'an honest whole-repo zero is NOT a filter miss — no warning',
    );
  } finally {
    await p.dispose();
  }
});
