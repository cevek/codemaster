// Cross-program WRITES for the move/extract + change_signature ops (spec Task G, mutations). A
// `test/**` file under a sibling `tsconfig.test.json` that imports a moved module, or calls a
// function whose signature changes, used to be left un-rewritten (the primary program can't see
// it) — a silent partial edit the primary-only §2.8 gate never caught. The fix fans the import
// rewrite (via a disk read), the call-site search, and the typecheck gate across every program.
// Oracle: a cold compile over tsconfig.test.json — the program that includes the test files.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { coldFindReferences, coldDiagnostics } from '../helpers/cold-ls.ts';
import type { JsonValue } from '../../src/core/json.ts';
import { project } from '../helpers/project.ts';

const COMPILER = '{"strict":true,"module":"esnext","moduleResolution":"bundler"}';
const TWO_PROGRAMS = {
  'tsconfig.json': `{"compilerOptions":${COMPILER},"include":["src"]}`,
  'tsconfig.test.json': `{"compilerOptions":${COMPILER},"include":["src","test"]}`,
};

type Envelope = {
  mode: string;
  diff: string;
  touched: string[];
  typecheck: { clean: boolean; introduced?: { file: string }[] };
  applied?: boolean;
  reason?: string;
};
type Proj = Awaited<ReturnType<typeof project>>;

async function op(p: Proj, name: string, args: JsonValue, apply = false): Promise<Envelope> {
  const [r] = await p.request([{ name, args, ...(apply ? { apply: true } : {}) }]);
  if (r === undefined || 'error' in r) assert.fail(`dispatch error: ${JSON.stringify(r)}`);
  assert.ok(r.result.ok, `expected ok, got ${JSON.stringify(r)}`);
  return r.result.data as unknown as Envelope;
}

test('move_file: a test/** importer under a sibling tsconfig is rewritten (not left dangling)', async () => {
  const p = await project({
    ...TWO_PROGRAMS,
    'src/lib/math.ts': 'export const add = (a: number, b: number): number => a + b;\n',
    'src/use.ts': "import { add } from './lib/math';\nexport const a = add(1, 2);\n",
    'test/math.test.ts': "import { add } from '../src/lib/math';\nexport const t = add(3, 4);\n",
  });
  try {
    const dry = await op(p, 'move_file', { source: 'src/lib/math.ts', dest: 'src/core/math.ts' });
    assert.equal(dry.typecheck.clean, true, JSON.stringify(dry.typecheck));
    assert.ok(
      dry.touched.includes('test/math.test.ts'),
      `the test importer is in the touched set: ${JSON.stringify(dry.touched)}`,
    );

    const applied = await op(
      p,
      'move_file',
      { source: 'src/lib/math.ts', dest: 'src/core/math.ts' },
      true,
    );
    assert.equal(applied.applied, true, JSON.stringify(applied));
    assert.match(
      readFileSync(path.join(p.root, 'test/math.test.ts'), 'utf8'),
      /from ['"]\.\.\/src\/core\/math['"]/,
      'the test import followed the move',
    );
    // Cold oracle over tsconfig.test.json: both importers resolve to the moved file.
    assert.deepEqual(
      coldFindReferences(p.root, 'src/core/math.ts', 'add', 'tsconfig.test.json'),
      ['src/core/math.ts', 'src/use.ts', 'test/math.test.ts'],
      'cold cross-program oracle: no dangling test import',
    );
  } finally {
    await p.dispose();
  }
});

test('move_file: a moved file entering a sibling program does NOT mis-count that sibling’s pre-existing error', async () => {
  // Symmetry regression: the affected-program set is recomputed from `containsFile` at apply time.
  // Moving `src/a.ts` → `extra/a.ts` makes the (disjoint) `tsconfig.extra.json` program newly
  // contain the moved file → a naive post-apply re-`affected()` would sample that sibling, whose
  // PRE-EXISTING `extra/bad.ts` error the pre-apply baseline never saw → mis-counted as introduced
  // → a false rollback + a lie. The post-apply check must pin the pre-apply program set.
  const p = await project({
    'tsconfig.json': `{"compilerOptions":${COMPILER},"include":["src"]}`,
    'tsconfig.extra.json': `{"compilerOptions":${COMPILER},"include":["extra"]}`,
    'src/a.ts': 'export const a = 1;\n',
    // A pre-existing error visible ONLY to the sibling program (disjoint glob).
    'extra/bad.ts': "export const bad: number = 'not a number';\n",
  });
  try {
    const dry = await op(p, 'move_file', { source: 'src/a.ts', dest: 'extra/a.ts' });
    assert.equal(dry.typecheck.clean, true, JSON.stringify(dry.typecheck));
    const applied = await op(p, 'move_file', { source: 'src/a.ts', dest: 'extra/a.ts' }, true);
    assert.equal(
      applied.applied,
      true,
      `the sibling's pre-existing error must not roll back a sound move: ${JSON.stringify(applied)}`,
    );
    assert.ok(
      readFileSync(path.join(p.root, 'extra/a.ts'), 'utf8').includes('export const a'),
      'the move actually landed',
    );
  } finally {
    await p.dispose();
  }
});

// ── HIGH: a moved file landing in a DISJOINT dest program whose compilerOptions diverge ──────────
// `src/a.ts` is clean under the PRIMARY config (strict:false → implicit-any allowed) but ERRORS
// under the dest program's config (strict:true → noImplicitAny). The dest dir is owned by a sibling
// tsconfig whose glob does NOT cover the source zone, so a `containsFile`-only affected-set (the file
// doesn't exist at the dest yet) would never typecheck the moved file under the dest options → the
// move would apply `clean:true` and silently break the sibling. The gate MUST refuse. Oracle: an
// independent cold compile proves the SAME content's status diverges by config (clean vs erroneous).
const DISJOINT = {
  'tsconfig.json':
    '{"compilerOptions":{"strict":false,"module":"esnext","moduleResolution":"bundler"},"include":["src"]}',
  'tsconfig.scripts.json':
    '{"compilerOptions":{"strict":true,"module":"esnext","moduleResolution":"bundler"},"include":["scripts"]}',
  // implicit-any param: fine under strict:false, a noImplicitAny error under strict:true.
  'src/a.ts': 'export const f = (x) => x.foo;\n',
  'scripts/keep.ts': 'export const k = 1;\n',
};

test('ORACLE: the moved content is clean under the primary config but errors under the dest config', async () => {
  // The independent ground truth (a fresh cold Program per config) — the same bytes, two verdicts.
  const oracle = await project({
    ...DISJOINT,
    'scripts/a.ts': 'export const f = (x) => x.foo;\n', // physically placed under the dest config
  });
  try {
    assert.deepEqual(
      coldDiagnostics(oracle.root, 'tsconfig.json'),
      [],
      'clean under primary (strict:false)',
    );
    const scriptsDiag = coldDiagnostics(oracle.root, 'tsconfig.scripts.json');
    assert.ok(
      scriptsDiag.some((d) => /implicitly has an 'any' type/.test(d)),
      `dest config (strict:true) flags the moved file: ${JSON.stringify(scriptsDiag)}`,
    );
  } finally {
    await oracle.dispose();
  }
});

test('move_file: a file moved into a disjoint dest program errors under THAT program — gate refuses', async () => {
  const p = await project(DISJOINT);
  try {
    const dry = await op(p, 'move_file', { source: 'src/a.ts', dest: 'scripts/a.ts' });
    assert.equal(
      dry.typecheck.clean,
      false,
      `the moved file errors under the dest program — the gate must NOT report clean: ${JSON.stringify(dry.typecheck)}`,
    );
    assert.ok(
      (dry.typecheck.introduced ?? []).some((d) => d.file === 'scripts/a.ts'),
      `the introduced error is the moved file under its new (dest) program: ${JSON.stringify(dry.typecheck.introduced)}`,
    );
    // And apply is refused — nothing written.
    const applied = await op(p, 'move_file', { source: 'src/a.ts', dest: 'scripts/a.ts' }, true);
    assert.equal(applied.applied, false, `apply must be refused: ${JSON.stringify(applied)}`);
    assert.equal(p.git('status', '--porcelain'), '', 'nothing written on a refused move');
  } finally {
    await p.dispose();
  }
});

test('extract_symbol: a symbol extracted into a disjoint dest program errors under THAT program — gate refuses', async () => {
  const p = await project(DISJOINT);
  try {
    const dry = await op(p, 'extract_symbol', { name: 'f', dest: 'scripts/extracted.ts' });
    assert.equal(
      dry.typecheck.clean,
      false,
      `the extracted block errors under the dest program — the gate must NOT report clean: ${JSON.stringify(dry.typecheck)}`,
    );
    assert.ok(
      (dry.typecheck.introduced ?? []).some((d) => d.file === 'scripts/extracted.ts'),
      `the introduced error is the new file under its (dest) program: ${JSON.stringify(dry.typecheck.introduced)}`,
    );
  } finally {
    await p.dispose();
  }
});

test('move_file: a move into a dir NO tsconfig glob owns still applies (primary checks the unowned dest)', async () => {
  // Regression guard for the per-program overlay filter: each program (primary included) is overlaid
  // only with files it OWNS — but a dest in a dir outside every tsconfig `include` is owned by NO
  // program, so without a fallback the rewritten importer would resolve the moved-to specifier
  // against an un-overlaid dest → a spurious "Cannot find module" → a FALSE refusal. The primary
  // claims any genuinely-unowned path, so a sound move into an unindexed dir stays clean.
  const p = await project({
    'tsconfig.json': '{"compilerOptions":{"strict":true,"module":"preserve"},"include":["src"]}', // explicit include — `out/` is owned by nothing
    'src/a.ts': 'export const a = 1;\n',
    'src/use.ts': "import { a } from './a';\nexport const b = a + 1;\n",
  });
  try {
    const dry = await op(p, 'move_file', { source: 'src/a.ts', dest: 'out/a.ts' });
    assert.equal(
      dry.typecheck.clean,
      true,
      `a move into an unindexed dir must not falsely refuse on the rewritten importer: ${JSON.stringify(dry.typecheck)}`,
    );
    const applied = await op(p, 'move_file', { source: 'src/a.ts', dest: 'out/a.ts' }, true);
    assert.equal(applied.applied, true, JSON.stringify(applied));
    assert.match(
      readFileSync(path.join(p.root, 'src/use.ts'), 'utf8'),
      /from ['"]\.\.\/out\/a['"]/,
      'the importer followed the move into the unindexed dir',
    );
  } finally {
    await p.dispose();
  }
});

test('change_signature: a test/** call site under a sibling tsconfig is rewritten', async () => {
  const p = await project({
    ...TWO_PROGRAMS,
    'src/api.ts': 'export const greet = (name: string, loud: boolean): string => name;\n',
    'src/use.ts': "import { greet } from './api';\nexport const a = greet('hi', true);\n",
    'test/api.test.ts':
      "import { greet } from '../src/api';\nexport const t = greet('yo', false);\n",
  });
  try {
    // Remove the 2nd parameter — every call (incl. the test program's) must drop its 2nd arg.
    const applied = await op(p, 'change_signature', { name: 'greet', removeParam: 1 }, true);
    assert.equal(applied.applied, true, JSON.stringify(applied));
    assert.match(
      readFileSync(path.join(p.root, 'test/api.test.ts'), 'utf8'),
      /greet\(['"]yo['"]\)/,
      "the test call dropped its 2nd arg (was: left as greet('yo', false) — a type error)",
    );
  } finally {
    await p.dispose();
  }
});

test('change_signature: the call-site search reaches the test program — a non-call use there refuses', async () => {
  // The ONLY non-call use of `greet` lives in the TEST program (passed as a value to `.map`).
  // change_signature is conservative: a non-call use it can't faithfully rewrite refuses the WHOLE
  // op. A primary-only search would never see the test use → it would apply and silently corrupt
  // the test call; the cross-program search sees it and the refusal NAMES the test file.
  const src =
    'export const greet = (name: string, loud: boolean): string => (loud ? name : name);\n';
  const tst = "import { greet } from '../src/api';\nexport const t = ['a'].map(greet);\n";
  const p = await project({
    ...TWO_PROGRAMS,
    'src/api.ts': src,
    'src/use.ts': "import { greet } from './api';\nexport const a = greet('hi', true);\n",
    'test/api.test.ts': tst,
  });
  try {
    const [r] = await p.request([
      { name: 'change_signature', args: { name: 'greet', removeParam: 1 }, apply: true },
    ]);
    if (r === undefined || 'error' in r) assert.fail(`dispatch error: ${JSON.stringify(r)}`);
    assert.equal(r.result.ok, false, 'a non-call use in the test program must refuse the op');
    assert.match(
      String(r.result.ok ? '' : r.result.failure.message),
      /test\/api\.test\.ts.*non-call use/,
      'the refusal names the test-program use (cross-program search reached it)',
    );
    assert.equal(p.git('status', '--porcelain'), ''); // nothing written
    assert.equal(readFileSync(path.join(p.root, 'test/api.test.ts'), 'utf8'), tst);
  } finally {
    await p.dispose();
  }
});
