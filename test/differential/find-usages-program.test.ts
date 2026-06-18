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

function usagesOf(r: OpResult): Usage[] {
  assert.ok('result' in r && r.result.ok, JSON.stringify(r));
  return (r.result.data as { usages?: Usage[] }).usages ?? [];
}

test('a test-only ref is labeled tsconfig.test.json; a src ref is labeled the primary program', async () => {
  const p: TestProject = await project(FILES);
  try {
    const u = usagesOf(await p.op('find_usages', { name: 'nullWatcher', collapseImports: false }));

    // Independent oracle: the cross-program ground truth (the test file is in tsconfig.test.json).
    const oracle = coldFindReferences(p.root, 'src/seam.ts', 'nullWatcher', 'tsconfig.test.json');
    assert.ok(oracle.includes('test/seam.test.ts'), 'oracle: the test usage exists');

    // The test-file ref carries the SIBLING program label — and a sibling label is unambiguous:
    // present ONLY in that program (the cardinal "test-only?" answer made self-serve).
    const testRef = u.find((x) => x.span.file === 'test/seam.test.ts');
    assert.ok(testRef !== undefined, 'the test-program usage is present');
    assert.equal(testRef.program, 'tsconfig.test.json', 'tagged with its surfacing program');

    // A src ref carries the primary label (primary-preferred dedup).
    const srcRef = u.find((x) => x.span.file === 'src/seam.ts' && x.role !== 'decl');
    assert.ok(srcRef !== undefined, 'a src usage is present');
    assert.equal(srcRef.program, 'tsconfig.json', 'src ref tagged with the primary program');
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
    const u = usagesOf(await p.op('find_usages', { name: 'x', collapseImports: false }));
    assert.ok(u.length > 0, 'has usages');
    assert.ok(
      u.every((r) => r.program === undefined),
      'single-program rows carry no program decoration',
    );
  } finally {
    await p.dispose();
  }
});
