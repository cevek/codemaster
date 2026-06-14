// Stage F edit-safety oracle for move_file (§16.4), git-backed. The discriminating fixture:
// one file imported by TWO importers — one via a tsconfig alias, one via a relative path —
// and the moved file has its OWN relative import. Moving it exercises alias-emit,
// relative-emit, the moved-file self-rewrite, and history preservation at once. Oracles
// independent of the warm LS: a COLD ts.Program compile (a missed/wrong rewrite surfaces as
// "cannot find module"), `git log --follow` for history, and diff(dry)==diff(apply).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { coldDiagnostics as coldTscErrors } from '../helpers/cold-ls.ts';
import type { JsonValue } from '../../src/core/json.ts';
import { project } from '../helpers/project.ts';

const TSCONFIG =
  '{"compilerOptions":{"strict":true,"module":"preserve","baseUrl":".","paths":{"@/*":["src/*"]},"ignoreDeprecations":"6.0"}}';

type Envelope = {
  mode: string;
  diff: string;
  touched: string[];
  typecheck: { clean: boolean };
  applied?: boolean;
};
type Proj = Awaited<ReturnType<typeof project>>;

async function move(p: Proj, args: JsonValue, apply = false): Promise<Envelope> {
  const [r] = await p.request([{ name: 'move_file', args, ...(apply ? { apply: true } : {}) }]);
  if (r === undefined || 'error' in r) assert.fail(`dispatch error: ${JSON.stringify(r)}`);
  assert.ok(r.result.ok, `expected ok, got ${JSON.stringify(r)}`);
  return r.result.data as unknown as Envelope;
}

test('move_file: alias + relative importers rewritten, self-import re-emitted, history kept', async () => {
  const p = await project({
    'tsconfig.json': TSCONFIG,
    'src/lib/k.ts': 'export const K = 0;\n',
    'src/lib/math.ts':
      "import { K } from './k';\nexport const add = (a: number, b: number): number => a + b + K;\n",
    'src/alias-user.ts': "import { add } from '@/lib/math';\nexport const r: number = add(1, 2);\n",
    'src/rel/rel-user.ts':
      "import { add } from '../lib/math';\nexport const s: number = add(3, 4);\n",
  });
  try {
    const dry = await move(p, { source: 'src/lib/math.ts', dest: 'src/core/math.ts' });
    assert.equal(dry.mode, 'dry-run');
    assert.equal(dry.typecheck.clean, true);
    assert.equal(p.git('status', '--porcelain'), ''); // zero writes

    const applied = await move(p, { source: 'src/lib/math.ts', dest: 'src/core/math.ts' }, true);
    assert.equal(applied.mode, 'applied');
    assert.equal(applied.typecheck.clean, true);
    assert.equal(applied.diff, dry.diff); // diff(dry) === diff(apply)

    // Independent cold compile — a missed or wrong rewrite fails it.
    assert.deepEqual(coldTscErrors(p.root), []);
    const read = (rel: string): string => readFileSync(path.join(p.root, rel), 'utf8');
    assert.match(read('src/alias-user.ts'), /from ['"]@\/core\/math['"]/); // alias preserved
    assert.match(read('src/rel/rel-user.ts'), /from ['"]\.\.\/core\/math['"]/); // relative re-emitted
    assert.match(read('src/core/math.ts'), /from ['"]\.\.\/lib\/k['"]/); // moved file's OWN import re-emitted
    // History preserved across the move.
    p.git('add', '-A');
    p.git('commit', '-q', '-m', 'moved');
    assert.match(p.git('log', '--follow', '--format=%s', '--', 'src/core/math.ts'), /fixture/);
  } finally {
    await p.dispose();
  }
});

test('move_file: a `typeof import()` type-position importer is rewritten (not missed)', async () => {
  const p = await project({
    'tsconfig.json': TSCONFIG,
    'src/Button.ts': 'export const Button: number = 1;\n',
    'src/consumer.ts':
      "export type T = typeof import('./Button');\nexport const u: T = { Button: 2 };\n",
  });
  try {
    const applied = await move(p, { source: 'src/Button.ts', dest: 'src/ui/Button.ts' }, true);
    assert.equal(applied.typecheck.clean, true);
    assert.deepEqual(coldTscErrors(p.root), []); // a missed type-import would dangle here
    assert.match(
      readFileSync(path.join(p.root, 'src/consumer.ts'), 'utf8'),
      /import\(['"]\.\/ui\/Button['"]\)/,
    );
  } finally {
    await p.dispose();
  }
});

test('move_file: an aliased `.scss` importer is rewritten (wildcard @/* — gate-blind)', async () => {
  // TS never typechecks an `.scss` import, so a missed rewrite of an aliased stylesheet
  // specifier dangles silently past the §2.8 gate. The wildcard `@/*` alias must be rewritten
  // on a move; the specifier text is the oracle (an ambient decl keeps both old/new clean).
  const p = await project({
    'tsconfig.json': TSCONFIG, // @/* → src/*
    'src/scss.d.ts':
      "declare module '*.module.scss' { const s: Record<string, string>; export default s; }\n",
    'src/styles/x.module.scss': '.foo {\n  color: red;\n}\n',
    'src/alias-user.ts': "import s from '@/styles/x.module.scss';\nexport const a = s.foo;\n",
  });
  try {
    const env = await move(
      p,
      { source: 'src/styles/x.module.scss', dest: 'src/ui/x.module.scss' },
      true,
    );
    assert.equal(env.applied, true);
    assert.match(
      readFileSync(path.join(p.root, 'src/alias-user.ts'), 'utf8'),
      /from ['"]@\/ui\/x\.module\.scss['"]/,
    );
  } finally {
    await p.dispose();
  }
});

test('move_file: a NON-wildcard paths key does not over-match an unrelated specifier', async () => {
  // A bare (non-`*`) tsconfig key is an EXACT mapping, not a prefix. Moving a file under its
  // target dir must NOT rewrite an unrelated specifier that merely shares the key's prefix
  // (`@scss/x` vs a bare `@s` key) — that would be a silent misidentification, and TS never
  // typechecks `.scss` so the gate can't catch it.
  const TSCONFIG_BARE =
    '{"compilerOptions":{"strict":true,"module":"preserve","baseUrl":".","paths":{"@/*":["src/*"],"@s":["src/s"]},"ignoreDeprecations":"6.0"}}';
  const p = await project({
    'tsconfig.json': TSCONFIG_BARE,
    'src/scss.d.ts':
      "declare module '*.scss' { const s: Record<string, string>; export default s; }\n",
    'src/s/css/theme.scss': '.foo {\n  color: red;\n}\n',
    'src/user.ts': "import t from '@scss/theme.scss';\nexport const a = t.foo;\n", // unrelated namespace
  });
  try {
    const env = await move(
      p,
      { source: 'src/s/css/theme.scss', dest: 'src/relocated/theme.scss' },
      true,
    );
    assert.equal(env.applied, true);
    // '@scss/theme.scss' is NOT the moved module — must stay byte-identical, never repointed.
    assert.match(
      readFileSync(path.join(p.root, 'src/user.ts'), 'utf8'),
      /from ['"]@scss\/theme\.scss['"]/,
    );
  } finally {
    await p.dispose();
  }
});

test('move_file: a .js importer is rewritten in an allowJs project', async () => {
  // A .js/.jsx importer of a moved module is in the program under allowJs but is never
  // `checkJs`-typechecked, so the §2.8 gate can't catch a dangling .js import — the rewriter
  // must handle it, and the specifier text is the oracle.
  const ALLOW_JS =
    '{"compilerOptions":{"allowJs":true,"strict":true,"module":"preserve","baseUrl":".","ignoreDeprecations":"6.0"}}';
  const p = await project({
    'tsconfig.json': ALLOW_JS,
    'src/lib.ts': 'export const v: number = 1;\n',
    'src/use.js': "import { v } from './lib';\nexport const w = v;\n",
  });
  try {
    const env = await move(p, { source: 'src/lib.ts', dest: 'src/core/lib.ts' }, true);
    assert.equal(env.applied, true);
    assert.match(
      readFileSync(path.join(p.root, 'src/use.js'), 'utf8'),
      /from ['"]\.\/core\/lib['"]/,
    );
  } finally {
    await p.dispose();
  }
});

test('move_file: a moved `.d.ts` rewrites an ext-omitted importer to ./foo (not ./foo.d)', async () => {
  // path.extname('foo.d.ts') is '.ts', so a naive strip would emit './foo.d'; emit must treat
  // `.d.ts` as one module extension and produce the clean './foo'.
  const p = await project({
    'tsconfig.json': TSCONFIG,
    'src/types.d.ts': 'export type T = { n: number };\n',
    'src/use.ts': "import type { T } from './types';\nexport const v: T = { n: 1 };\n",
  });
  try {
    const env = await move(p, { source: 'src/types.d.ts', dest: 'src/foo.d.ts' }, true);
    assert.equal(env.applied, true);
    assert.match(readFileSync(path.join(p.root, 'src/use.ts'), 'utf8'), /from ['"]\.\/foo['"]/);
  } finally {
    await p.dispose();
  }
});

test('move_file: REFUSED when the destination is a gitignored existing path (no rollback over-delete)', async () => {
  // git ls-files (--cached --others --exclude-standard) — the tree's universe — excludes
  // GITIGNORED paths, so planMove's tree-collision check can't see a file under e.g. dist/.
  // Without the disk-level destination guard, commitMove's git mv fails ("destination exists")
  // → rollback rmSync's the move target → DELETES the pre-existing gitignored file the op
  // never created. (A tracked or untracked-not-ignored dest is already caught by planMove.)
  const p = await project({
    'tsconfig.json': TSCONFIG,
    '.gitignore': 'dist/\n',
    'src/old.ts': 'export const x = 1;\n',
  });
  try {
    mkdirSync(path.join(p.root, 'dist'), { recursive: true });
    writeFileSync(path.join(p.root, 'dist/old.ts'), 'export const artifact = 42;\n'); // gitignored

    const env = await move(p, { source: 'src/old.ts', dest: 'dist/old.ts' }, true);
    assert.equal(env.applied, false); // refused before any disk mutation
    assert.equal(
      readFileSync(path.join(p.root, 'dist/old.ts'), 'utf8'),
      'export const artifact = 42;\n', // survived — rollback never ran to delete it
    );
    assert.equal(readFileSync(path.join(p.root, 'src/old.ts'), 'utf8'), 'export const x = 1;\n'); // source untouched
  } finally {
    await p.dispose();
  }
});

test('move_file: a carried-sibling collision fails honestly (no crash)', async () => {
  const p = await project({
    'tsconfig.json': TSCONFIG,
    'src/a.ts': 'export const a = 1;\n',
    'src/a.module.scss': '.x {\n}\n',
    'lib/keep.ts': 'export const k = 1;\n',
    'lib/a.module.scss': '.y {\n}\n', // pre-existing — the carried sibling would collide here
  });
  try {
    const [r] = await p.request([
      { name: 'move_file', args: { source: 'src/a.ts', dest: 'lib/a.ts' }, apply: true },
    ]);
    assert.ok(
      r !== undefined && 'result' in r && !r.result.ok,
      'sibling collision must fail, not crash',
    );
    if ('result' in r && !r.result.ok)
      assert.match(r.result.failure.message, /cannot move|collision/);
    assert.equal(p.git('status', '--porcelain'), '');
  } finally {
    await p.dispose();
  }
});
