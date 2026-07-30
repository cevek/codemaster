// Empty-WALK honesty (§3.4/§3.6): a scan that opened ZERO files examined nothing, so `unused (0)`
// is NOT proof that no exports are dead — it is "nothing was examined". The op must surface a LOUD
// `notAVerdict` marker so an agent never reads a vacuous scan as clean and acts on it. Two causes
// reach that state and BOTH are covered (t-000011): a `pathInclude`/`pathExclude` matching nothing,
// and a program covering no source file at all (a degenerate `include`) — the latter carries no
// filter, which is exactly why the old `filterSet &&` gate let it through as a false clean.
// One key for both, because a consumer that must probe two keys to learn whether a verdict exists
// is the defect this closes; the CAUSE and its own lever live in the text.
// The honest whole-repo zero (no filter, real files walked, really no dead exports) must NOT carry
// the marker. Oracle = a fixture whose file set is fixed by construction: a real dead export exists,
// so a 0-files result can ONLY mean the walk missed it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { project } from '../helpers/project.ts';

type Unused = { name: string; confidence: string };
type WarnView = {
  unused: Unused[];
  scanned: { exports: number; files: number };
  notAVerdict?: string;
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
      typeof data.notAVerdict === 'string' && data.notAVerdict.length > 0,
      'a vacuous filter raises the loud warning',
    );
    assert.match(
      data.notAVerdict ?? '',
      /0 files/i,
      'the warning states the filter matched 0 files',
    );
    assert.match(
      data.notAVerdict ?? '',
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
      typeof data.notAVerdict === 'string' && data.notAVerdict.length > 0,
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
    assert.equal(data.notAVerdict, undefined, 'no warning when the filter matched files');
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

// t-000011 — the half no filter can explain. The program's own `include` covers nothing, so the walk
// opens 0 files with NO filter set: under the old `filterSet &&` gate this printed a bare `unused (0)
// scanned exports=0 files=0`, i.e. "no dead exports" over a scan that never happened. Its remedy is
// also different in kind — no glob can be widened into a program that covers no source — so the
// marker must name the tsconfig, not `pathInclude` (an inert lever is the §3.6 defect next door).
test('find_unused_exports: a program covering 0 source files is NOT a verdict (no filter to blame)', async () => {
  const p = await project({
    // Oracle by construction: `dead` IS exported and imported by nobody, so a truthful whole-repo
    // scan of these sources would report exactly one dead export. A `0` here can therefore ONLY mean
    // nothing was walked — never "the repo is clean".
    'tsconfig.json': '{"compilerOptions":{"strict":true},"include":[]}',
    'src/lib.ts': 'export const dead = 1;\n',
  });
  try {
    const r = await p.op('find_unused_exports', {});
    assert.ok(
      'result' in r && r.result.ok,
      'a finished-but-empty walk stays ok — it is not a crash',
    );
    const data = r.result.data as WarnView;
    assert.equal(data.scanned.files, 0, 'the degenerate include left no file in the program');
    assert.equal(data.unused.length, 0, 'and so nothing was reported dead');
    assert.ok(
      typeof data.notAVerdict === 'string' && data.notAVerdict.length > 0,
      'an empty walk with NO filter set must still refuse the verdict',
    );
    assert.match(data.notAVerdict ?? '', /NOT A VERDICT/, 'the shared empty-scan marker');
    assert.match(
      data.notAVerdict ?? '',
      /tsconfig/i,
      'it names the lever that can change the outcome — the program, not a glob',
    );
    assert.doesNotMatch(
      data.notAVerdict ?? '',
      /Check your path\(s\)/i,
      'and NOT the filter remedy, which is inert when no filter was set',
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
      data.notAVerdict,
      undefined,
      'an honest whole-repo zero is NOT a filter miss — no warning',
    );
  } finally {
    await p.dispose();
  }
});
