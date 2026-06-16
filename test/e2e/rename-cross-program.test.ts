// Cross-program WRITES (spec Task G, for mutations). A `src/**` symbol referenced from a `test/**`
// file under a sibling `tsconfig.test.json` used to rename ONLY its primary-program sites — the
// test reference dangled (a silent partial edit) and the primary-only §2.8 gate never saw it. The
// fix fans BOTH the rename-site computation AND the typecheck gate across every loaded program.
// Two oracle-backed cases pin it on a two-tsconfig fixture:
//   1. POSITIVE — a clean cross-program rename rewrites BOTH sites; a cold LS over tsconfig.test.json
//      (a DIFFERENT program than the warm primary) confirms both files resolve to the new name.
//   2. NEGATIVE — a rename that introduces an error visible ONLY in the test program is REFUSED by
//      the fanned gate (a primary-only gate would have applied it → a broken test program).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { coldFindReferences } from '../helpers/cold-ls.ts';
import type { JsonValue } from '../../src/core/json.ts';
import { project } from '../helpers/project.ts';

const COMPILER = '{"strict":true,"module":"esnext","moduleResolution":"bundler"}';
const TWO_PROGRAMS = {
  // Primary program: src only — it does NOT see the test files.
  'tsconfig.json': `{"compilerOptions":${COMPILER},"include":["src"]}`,
  // Sibling program: src + test — the program where the test-only reference lives.
  'tsconfig.test.json': `{"compilerOptions":${COMPILER},"include":["src","test"]}`,
};

type Envelope = {
  mode: string;
  diff: string;
  touched: string[];
  typecheck: { clean: boolean; introduced?: { file: string; line: number; message: string }[] };
  applied?: boolean;
  reason?: string;
  captures?: { at: string; kind: string; detail: string }[];
};
type Proj = Awaited<ReturnType<typeof project>>;

async function rename(p: Proj, args: JsonValue, apply = false): Promise<Envelope> {
  const [r] = await p.request([{ name: 'rename_symbol', args, ...(apply ? { apply: true } : {}) }]);
  if (r === undefined || 'error' in r) assert.fail(`dispatch error: ${JSON.stringify(r)}`);
  assert.ok(r.result.ok, `expected ok, got ${JSON.stringify(r)}`);
  return r.result.data as unknown as Envelope;
}

test('rename_symbol: a src symbol referenced from a test/** sibling program rewrites BOTH sites', async () => {
  const p = await project({
    ...TWO_PROGRAMS,
    'src/seam.ts':
      'export const target = 1;\n' + 'export const useTarget = (): number => target;\n',
    'test/seam.test.ts': "import { target } from '../src/seam';\nexport const t = target + 1;\n",
  });
  try {
    // Dry-run: the touched set spans BOTH programs (the test reference is no longer dropped).
    const dry = await rename(p, { name: 'target', newName: 'renamed' });
    assert.equal(dry.typecheck.clean, true);
    assert.deepEqual(
      [...dry.touched].sort(),
      ['src/seam.ts', 'test/seam.test.ts'],
      'the test/** site is in the touched set (was: src only — a silent partial)',
    );
    assert.equal(p.git('status', '--porcelain'), ''); // zero writes on dry-run

    // Apply: both files rewritten on disk.
    const applied = await rename(p, { name: 'target', newName: 'renamed' }, true);
    assert.equal(applied.applied, true);
    assert.equal(applied.diff, dry.diff); // diff(dry) === diff(apply)
    assert.match(readFileSync(path.join(p.root, 'src/seam.ts'), 'utf8'), /export const renamed/);
    assert.match(
      readFileSync(path.join(p.root, 'test/seam.test.ts'), 'utf8'),
      /import \{ renamed \}/,
      'the test reference followed the rename — not left dangling',
    );

    // Independent oracle: a cold LS over tsconfig.test.json (the program that includes the test
    // files, NOT the warm primary the op used) — both files must resolve to the new name.
    assert.deepEqual(
      coldFindReferences(p.root, 'src/seam.ts', 'renamed', 'tsconfig.test.json'),
      ['src/seam.ts', 'test/seam.test.ts'],
      'cold cross-program oracle: both sites bind to the renamed symbol',
    );
  } finally {
    await p.dispose();
  }
});

test('rename_symbol: the §2.8 gate fans across programs — a test-program-only error refuses apply', async () => {
  // `taken` exists ONLY in the test program (a local there). Renaming target→taken makes the test
  // file `import { taken }` collide with its `const taken` — a duplicate-identifier the PRIMARY
  // program (src only) cannot see. A primary-only gate would apply this and break the test program;
  // the fanned gate must catch it on the test program and refuse, leaving every file byte-identical.
  const src = 'export const target = 1;\nexport const useTarget = (): number => target;\n';
  const tst =
    "import { target } from '../src/seam';\nconst taken = 2;\nexport const t = target + taken;\n";
  const p = await project({ ...TWO_PROGRAMS, 'src/seam.ts': src, 'test/seam.test.ts': tst });
  try {
    const r = await rename(p, { name: 'target', newName: 'taken' }, true);
    assert.equal(r.applied, false, 'a cross-program-breaking rename must refuse apply');
    assert.equal(r.typecheck.clean, false, 'the gate is unclean (caught on the test program)');
    assert.equal(r.captures, undefined, 'this is a typecheck error, not a capture');
    assert.match(String(r.reason), /typecheck|§2\.8/);
    // The introduced diagnostic lives in the TEST file — proof the gate fanned to the sibling.
    assert.ok(
      (r.typecheck.introduced ?? []).some((d) => d.file === 'test/seam.test.ts'),
      `the introduced error is in the test program: ${JSON.stringify(r.typecheck.introduced)}`,
    );
    assert.equal(p.git('status', '--porcelain'), ''); // byte-identical — nothing written
    assert.equal(readFileSync(path.join(p.root, 'src/seam.ts'), 'utf8'), src);
    assert.equal(readFileSync(path.join(p.root, 'test/seam.test.ts'), 'utf8'), tst);
  } finally {
    await p.dispose();
  }
});
