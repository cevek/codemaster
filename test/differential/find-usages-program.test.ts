// Per-program provenance on find_usages reference rows (Task G DX feedback): a ref row alone could
// not say WHICH loaded program surfaced it (primary vs `tsconfig.test.json`), so an agent couldn't
// answer "is this ref ONLY in the test program?". Each multi-program usage now carries a `program`
// label, making cross-program reasoning self-serve.
//
// HONEST ASYMMETRY (stated, never silent — §3): a SIBLING label means present ONLY there; the
// PRIMARY label means present in primary, POSSIBLY elsewhere too (primary-preferred dedup keeps one
// label and cannot enumerate every containing program). The field is emitted ONLY when more than one
// program is loaded — a single-program repo's row shape is unchanged.
//
// Oracle: a cold LS over `tsconfig.test.json` (a DIFFERENT program than the warm fan-out anchors on)
// confirms the test-only ref exists; the label assertion is the new provenance on top of it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { project, type TestProject } from '../helpers/project.ts';
import { coldFindReferences } from '../helpers/cold-ls.ts';
import type { OpResult } from '../../src/ops/contracts.ts';

type Usage = { span: { file: string; line: number }; role: string; program?: string };

const COMPILER = '{"strict":true,"module":"esnext","moduleResolution":"bundler"}';
const FILES = {
  'tsconfig.json': `{"compilerOptions":${COMPILER},"include":["src"]}`,
  'tsconfig.test.json': `{"compilerOptions":${COMPILER},"include":["src","test"]}`,
  'src/seam.ts':
    'export const nullWatcher = { tick: 0 };\n' + // used in src AND test
    'export const consume = (): number => nullWatcher.tick;\n', // a src usage
  'test/seam.test.ts':
    "import { nullWatcher } from '../src/seam';\n" + 'export const t = nullWatcher.tick + 1;\n',
};

function dataOf(r: OpResult): { usages?: Usage[]; allProgram?: string } {
  assert.ok('result' in r && r.result.ok, JSON.stringify(r));
  return r.result.data as { usages?: Usage[]; allProgram?: string };
}

test('the dominant (primary) program is hoisted to allProgram; a test-only ref keeps its sibling label', async () => {
  const p: TestProject = await project(FILES);
  try {
    const data = dataOf(await p.op('find_usages', { name: 'nullWatcher', collapseImports: false }));
    const u = data.usages ?? [];

    // Independent oracle: the cross-program ground truth (the test file is in tsconfig.test.json).
    const oracle = coldFindReferences(p.root, 'src/seam.ts', 'nullWatcher', 'tsconfig.test.json');
    assert.ok(oracle.includes('test/seam.test.ts'), 'oracle: the test usage exists');

    // Item 6 density: the dominant program (primary, surfaced first) is lifted ONCE into a header
    // field and dropped from each primary row — not repeated `· prog tsconfig.json` on every line.
    assert.equal(data.allProgram, 'tsconfig.json', 'the primary program is hoisted');

    // A primary src ref is now BARE (its program rides allProgram) — present in primary, possibly
    // elsewhere; honest asymmetry preserved by the note.
    const srcRef = u.find((x) => x.span.file === 'src/seam.ts' && x.role !== 'decl');
    assert.ok(srcRef !== undefined, 'a src usage is present');
    assert.equal(srcRef.program, undefined, 'a primary row is bare (hoisted to allProgram)');

    // The test-file ref keeps the SIBLING label — unambiguous: present ONLY in that program.
    const testRef = u.find((x) => x.span.file === 'test/seam.test.ts');
    assert.ok(testRef !== undefined, 'the test-program usage is present');
    assert.equal(testRef.program, 'tsconfig.test.json', 'a sibling ref stays tagged (only-there)');
  } finally {
    await p.dispose();
  }
});

test('single-program repo: no program field is emitted (row shape unchanged)', async () => {
  const p: TestProject = await project({
    'tsconfig.json': `{"compilerOptions":${COMPILER}}`,
    'src/x.ts': 'export const x = 1;\nexport const y = (): number => x + 1;\n',
  });
  try {
    const u = dataOf(await p.op('find_usages', { name: 'x', collapseImports: false })).usages ?? [];
    assert.ok(u.length > 0, 'has usages');
    assert.ok(
      u.every((r) => r.program === undefined),
      'single-program rows carry no program decoration',
    );
  } finally {
    await p.dispose();
  }
});
