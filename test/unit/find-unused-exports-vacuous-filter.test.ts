// Empty-WALK honesty (§3.4/§3.6): a scan that opened ZERO files examined nothing, so `unused (0)`
// is NOT proof that no exports are dead — it is "nothing was examined". The op must surface a LOUD
// `notAVerdict` marker so an agent never reads a vacuous scan as clean and acts on it. Two causes
// reach that state and BOTH are covered (t-000011): a `pathInclude`/`pathExclude` matching nothing,
// and a program covering no source file at all (a degenerate `include`).
// One key for both, because a consumer that must probe two keys to learn whether a verdict exists
// is the defect that closes; WHICH cause it was is a separate question with a separate answer —
// see below.
// The honest whole-repo zero (no filter, real files walked, really no dead exports) must NOT carry
// the marker. Oracle = a fixture whose file set is fixed by construction: a real dead export exists,
// so a 0-files result can ONLY mean the walk missed it.
//
// t-780551 — the CAUSE is read off the FILE SET, never off whether a filter arg was passed. The two
// causes have two different levers (fix the globs / fix the tsconfig), so blaming the filter for a
// program that holds no source names a lever no value of which could have helped — the inert-lever
// defect (t-259465) inside the message written to prevent it. Covered three ways: the degenerate
// program WITH a filter (where arg-presence and file-set disagree), the empty-array filter (which the
// scope predicate never even applies), and the machine discriminator (`eligibleFiles`) that must let
// a consumer tell the causes apart WITHOUT reading the prose.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { project } from '../helpers/project.ts';

type Unused = { name: string; confidence: string };
type WarnView = {
  unused: Unused[];
  scanned: {
    scope: string[];
    exports: number;
    candidateExports: number;
    files: number;
    eligibleFiles: number;
  };
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
    // The denominator is part of the claim, not decoration: "left 0 of the 2 file(s) the program
    // holds" is what proves the filter — and not the program set — emptied the walk. A looser
    // `/0/` would pass over a message that named no denominator at all.
    assert.match(
      data.notAVerdict ?? '',
      /left 0 of the \d+ source file/i,
      'the warning states what the filter LEFT, out of the files the program actually holds',
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
    // An EXCLUDE that empties the walk matched EVERY file — saying "your glob matched 0" would send
    // its author to widen the exclude, the one edit that keeps the walk empty forever. The message
    // has to be about what the filter LEFT, which is true of both filter kinds.
    assert.match(
      data.notAVerdict ?? '',
      /left 0 of the 2 source file/i,
      'it states what the filter left in scope, out of what the program holds',
    );
    assert.doesNotMatch(
      data.notAVerdict ?? '',
      /matched 0/i,
      'and never claims the glob matched nothing — `src/**` matched all of them',
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

/** A program whose own `include` covers nothing, beside a source file holding a real dead export.
 *  Oracle by construction: `dead` IS exported and imported by nobody, so a truthful whole-repo scan of
 *  these sources reports exactly one dead export. A `0` here can therefore ONLY mean nothing was
 *  walked — never "the repo is clean". */
const DEGENERATE = {
  'tsconfig.json': '{"compilerOptions":{"strict":true},"include":[]}',
  'src/lib.ts': 'export const dead = 1;\n',
};

// t-000011 — the half no filter can explain. The program's own `include` covers nothing, so the walk
// opens 0 files with NO filter set, and a bare `unused (0) scanned exports=0 files=0` would read as
// "no dead exports" over a scan that never happened. Its remedy is also different in kind — no glob
// can be widened into a program that covers no source — so the marker must name the tsconfig, not
// `pathInclude` (an inert lever is the §3.6 defect next door).
test('find_unused_exports: a program covering 0 source files is NOT a verdict (no filter to blame)', async () => {
  const p = await project(DEGENERATE);
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
      /the path filter .* left 0 of/i,
      'and NOT the filter remedy, which no glob value could satisfy here',
    );
  } finally {
    await p.dispose();
  }
});

// t-780551 — the case where arg-presence and the file set DISAGREE, which is the whole defect: a
// filter rides along, so an arg-presence gate blames the glob, while the program holds no file any
// glob could have matched. The cause must be read off the file set, so this answer has to be the
// tsconfig one — identical to the no-filter arm above.
test('find_unused_exports: a degenerate program WITH a pathInclude still blames the program, not the glob', async () => {
  const p = await project(DEGENERATE);
  try {
    const r = await p.op('find_unused_exports', { pathInclude: ['src/**'] });
    assert.ok('result' in r && r.result.ok, 'op succeeds');
    const data = r.result.data as WarnView;
    assert.equal(data.scanned.files, 0, 'nothing was walked');
    assert.equal(data.scanned.eligibleFiles, 0, 'because the program holds no source file at all');
    assert.match(data.notAVerdict ?? '', /NOT A VERDICT/, 'the verdict is refused');
    assert.match(
      data.notAVerdict ?? '',
      /covers 0 source files/i,
      'the message names the cause that actually emptied the walk',
    );
    assert.match(data.notAVerdict ?? '', /tsconfig/i, 'and the lever that can change it');
    // The load-bearing negative: `src/**` is a glob that matches the file on disk, so an answer
    // telling the caller to fix their globs is telling them to fix something that is not wrong and
    // cannot help. Reverting the branch to `filterSet` prints exactly that.
    assert.doesNotMatch(
      data.notAVerdict ?? '',
      /the path filter .* left 0 of/i,
      'it must NOT blame the filter — no glob could have matched a program with no files',
    );
  } finally {
    await p.dispose();
  }
});

// The same disagreement, from the other side: an EMPTY filter array is an arg that is present and
// never applied (`scopePredicate` ignores a zero-length list), so arg-presence blames a glob that had
// no effect on anything. The file set is the only discriminator that gets this right.
test('find_unused_exports: an empty pathInclude array is not a filter — it is never blamed', async () => {
  const p = await project(DEGENERATE);
  try {
    const empty = await p.op('find_unused_exports', { pathInclude: [] });
    const none = await p.op('find_unused_exports', {});
    assert.ok('result' in empty && empty.result.ok && 'result' in none && none.result.ok);
    const withArg = empty.result.data as WarnView;
    const withoutArg = none.result.data as WarnView;
    // A filter that is never applied cannot change the answer — the two must be identical, message
    // and counters alike.
    assert.equal(
      withArg.notAVerdict,
      withoutArg.notAVerdict,
      'an unapplied filter arg changes nothing about which cause emptied the walk',
    );
    assert.doesNotMatch(
      withArg.notAVerdict ?? '',
      /the path filter .* left 0 of/i,
      'and it is never named as the cause',
    );
  } finally {
    await p.dispose();
  }
});

// The oracle the prose cannot satisfy: strip every string from the two empty-walk answers and a
// consumer must STILL be able to tell the causes apart, because their remedies differ. `eligibleFiles`
// — the file set before the path filter — is that discriminator; a prose-only distinction would make
// the cause reachable only by regexing a message.
test('find_unused_exports: the two empty-walk causes differ MACHINE-readably, not just in prose', async () => {
  const degenerate = await project(DEGENERATE);
  const populated = await project(FIXTURE);
  try {
    const emptyProgram = await degenerate.op('find_unused_exports', { pathInclude: ['src/**'] });
    const emptyFilter = await populated.op('find_unused_exports', {
      pathInclude: ['src/does-not-exist/**'],
    });
    assert.ok('result' in emptyProgram && emptyProgram.result.ok);
    assert.ok('result' in emptyFilter && emptyFilter.result.ok);
    const a = (emptyProgram.result.data as WarnView).scanned;
    const b = (emptyFilter.result.data as WarnView).scanned;

    // Both walked nothing — that much they share, which is why the shared fields cannot discriminate.
    assert.equal(a.files, 0);
    assert.equal(b.files, 0);
    // And this is what tells them apart without reading a word.
    assert.equal(a.eligibleFiles, 0, 'the program held no source file to begin with');
    assert.ok(b.eligibleFiles > 0, 'the program held source files; the filter rejected them all');
    assert.notEqual(
      a.eligibleFiles,
      b.eligibleFiles,
      'two causes with two different levers must not be machine-indistinguishable',
    );
  } finally {
    await degenerate.dispose();
    await populated.dispose();
  }
});

// A repo with NO tsconfig at all falls back to the whole-repo no-config program (§10). Its label IS
// "(no tsconfig)", so the generic wording named that program in one clause and prescribed an
// `include`/`files` edit in the next — a remedy for a file that does not exist, self-contradicting
// inside one sentence. The cause is the same (no source walked); the LEVER is not.
test('find_unused_exports: a repo with no tsconfig is not told to fix its tsconfig', async () => {
  const p = await project({
    // Declaration files are excluded from the candidate walk, so the fallback program globs the repo
    // and holds no walkable source — the empty walk, reached with no config to blame.
    'src/types.d.ts': 'export declare const shape: number;\n',
  });
  try {
    const r = await p.op('find_unused_exports', {});
    assert.ok('result' in r && r.result.ok, 'op succeeds');
    const data = r.result.data as WarnView;
    assert.equal(data.scanned.eligibleFiles, 0, 'the fallback program holds no walkable source');
    assert.match(data.notAVerdict ?? '', /NOT A VERDICT/, 'the verdict is refused');
    assert.match(
      data.notAVerdict ?? '',
      /no tsconfig/i,
      'the message says the repo has none, rather than naming one that does not exist',
    );
    // The load-bearing negative: an `include`/`files` edit is impossible here, so prescribing it is
    // an inert lever — and it reads as one the moment the same sentence says there is no tsconfig.
    assert.doesNotMatch(
      data.notAVerdict ?? '',
      /`include`\/`files`/,
      'and never prescribes editing an include of a config that does not exist',
    );
    assert.match(
      data.notAVerdict ?? '',
      /add a tsconfig|point `root:`/i,
      'it names a lever that can actually change the outcome',
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
