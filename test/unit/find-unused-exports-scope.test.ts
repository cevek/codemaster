// t-762573 — the scan's scope, stated positively. `find_unused_exports` walks ONE program's files and
// examines a bounded slice of the exports it finds there, so a bare `scanned: exports=1 files=1` is a
// numerator with no denominator and no naming of what was searched. That shape has a measured cost:
// an agent read a four-file count as "scanned the repo", built a false theory of the mechanism from
// it, and named two triggers that a fixture then disproved. The fix is the form proven twice
// elsewhere (`ops/scan-coverage.ts`, `ops/trace-type-widening-scope.ts`): the denominator and the
// scope IN the line.
//
// The oracle is the fixture's own construction — the file set and the export set are fixed by the
// map below, so the denominators are known independently of anything codemaster reports. The prose is
// additionally cross-checked against the machine counters, since a scope line that drifts from the
// fields it describes is the same misread with an extra step.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { project } from '../helpers/project.ts';
import { findUnusedExportsOp } from '../../src/ops/find-unused-exports.ts';

type ScopeView = {
  scanned: {
    scope: string[];
    exports: number;
    candidateExports: number;
    files: number;
    eligibleFiles: number;
  };
};

// Three source files by construction; `src/feature/` holds exactly one of them, with exactly two
// exports. So a scoped call's honest scope is "1 of 3 files, 2 of 2 exports" — every number below is
// read off this map, never off a previous codemaster answer.
const FIXTURE = {
  'tsconfig.json': '{"compilerOptions":{"strict":true}}',
  'src/feature/widget.ts': 'export const alive = 1;\nexport const dead = 2;\n',
  'src/app.ts': "import { alive } from './feature/widget';\nconsole.log(alive);\n",
  'src/other.ts': 'export const elsewhere = 3;\n',
};

test('find_unused_exports: the scope line carries both denominators and NAMES what was walked', async () => {
  const p = await project(FIXTURE);
  try {
    const r = await p.op('find_unused_exports', { pathInclude: ['src/feature/**'] });
    assert.ok('result' in r && r.result.ok, 'op succeeds');
    const { scanned } = r.result.data as ScopeView;

    // The counters, against the fixture's own construction.
    assert.equal(scanned.files, 1, 'the filter narrowed the walk to the one feature file');
    assert.equal(scanned.eligibleFiles, 3, 'out of the three the program holds');
    assert.equal(scanned.candidateExports, 2, 'which declare two exports between them');

    // The line itself must state the pairs — a reader who sees only `files=1` cannot tell a
    // one-file repo from a one-of-three slice, which is exactly the misread this closes.
    const line = scanned.scope[0] ?? '';
    assert.match(
      line,
      /walked 1 of the 3 source file\(s\) it holds/,
      'the file pair, denominator included',
    );
    assert.match(
      line,
      new RegExp(`examined ${scanned.exports} of ${scanned.candidateExports} export\\(s\\)`),
      'the export pair, denominator included',
    );
    // And it must name the program those counts are OVER — without it, "of 3" is still a count over
    // an unnamed scope, and the repo/program confusion survives the denominator.
    assert.match(line, /^tsconfig\.json: /, 'the walked program is named, first');
  } finally {
    await p.dispose();
  }
});

// The export pair needs a case where its two numbers DIFFER. On a fixture where every candidate is
// examined, `examined X of Y` reads the same whichever number is which, so a swapped numerator and
// denominator would survive — the pair would be decoration, not a claim. `limit` forces the split,
// and the same call pins the scope line against the `truncated` field beside it: two renderings of
// one shortfall that must never disagree.
test('find_unused_exports: a capped walk states examined BELOW enumerated, and agrees with `truncated`', async () => {
  const p = await project(FIXTURE);
  try {
    const r = await p.op('find_unused_exports', { limit: 1 });
    assert.ok('result' in r && r.result.ok, 'op succeeds');
    const data = r.result.data as ScopeView & {
      truncated?: { examined: number; candidates: number };
    };
    assert.equal(data.scanned.exports, 1, 'the cap stopped after one reference search');
    assert.equal(data.scanned.candidateExports, 3, 'out of the three exports the repo declares');
    // The literal, with the two numbers distinct — a swap of numerator and denominator is red here.
    assert.match(
      data.scanned.scope[0] ?? '',
      /examined 1 of 3 export\(s\)/,
      'the scope line states the examined count BELOW the enumerated one',
    );
    // And the shortfall's other rendering must say the same thing, or one of the two is lying.
    assert.deepEqual(
      { examined: data.truncated?.examined, candidates: data.truncated?.candidates },
      { examined: data.scanned.exports, candidates: data.scanned.candidateExports },
      '`truncated` and the scope line report one shortfall, not two',
    );
  } finally {
    await p.dispose();
  }
});

test('find_unused_exports: the scope states enumeration as a fact and usage as a RULE — with no invented count', async () => {
  const p = await project(FIXTURE);
  try {
    const r = await p.op('find_unused_exports', {});
    assert.ok('result' in r && r.result.ok, 'op succeeds');
    const { scanned } = r.result.data as ScopeView;
    const rule = scanned.scope[1] ?? '';

    assert.match(
      rule,
      /single-program/,
      'candidate enumeration is single-program, and the answer says so',
    );
    assert.match(
      rule,
      /never a candidate/,
      'an export declared only in another program is named as a non-candidate — the limit of this walk',
    );
    // The usage fan is PER-CANDIDATE (the primary, then only for a candidate dead there, the programs
    // containing its file), so any "searched across N program(s)" would claim searches that never
    // ran — and the label set it would be counted from is what codemaster WILL load, not what it
    // consulted. No number belongs in this sentence; a symmetric lie is worse than asymmetric truth.
    assert.doesNotMatch(
      rule,
      /\d/,
      'the usage rule claims no count — a number here would name searches that never ran',
    );
  } finally {
    await p.dispose();
  }
});

test('find_unused_exports: the sql/table surface carries the same scope, not a re-derived one', async () => {
  const p = await project(FIXTURE);
  try {
    const r = await p.op('find_unused_exports', { pathInclude: ['src/feature/**'] });
    assert.ok('result' in r && r.result.ok, 'op succeeds');
    const data = r.result.data as ScopeView;
    const notes = findUnusedExportsOp.table?.notes?.(data) ?? [];
    const scopeNote = notes.find((n) => n.startsWith('scanned —'));
    assert.ok(
      scopeNote !== undefined,
      'the table surface renders no `scanned` block, so the scope must reach it as a note',
    );
    // Sourced from the same field, never re-assembled: two assemblers are two wordings that drift.
    for (const line of data.scanned.scope) {
      assert.ok(scopeNote.includes(line), `the note carries the scope line verbatim: ${line}`);
    }
  } finally {
    await p.dispose();
  }
});
