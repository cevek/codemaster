// Stage edit-safety oracle for move_symbol (§16.4): a top-level symbol moves A→EXISTING B, an
// independent cold ts.Program compiles clean, importers (incl. ALIASED) are repointed,
// diff(dry)==diff(apply), byte-exact rollback on an introduced error, dest name-collision and
// nested targets REFUSED (nothing written), dest-not-in-project fails.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { coldDiagnostics as coldTscErrors } from '../helpers/cold-ls.ts';
import type { JsonValue } from '../../src/core/json.ts';
import { project } from '../helpers/project.ts';

const TSCONFIG =
  '{"compilerOptions":{"strict":true,"module":"preserve","paths":{"@/*":["./src/*"]}}}';

type Envelope = {
  mode: string;
  diff: string;
  touched: string[];
  typecheck: { clean: boolean };
  applied?: boolean;
  reason?: string;
  captures?: unknown[];
};
type Proj = Awaited<ReturnType<typeof project>>;

async function move(p: Proj, args: JsonValue, apply = false): Promise<Envelope> {
  const [r] = await p.request([{ name: 'move_symbol', args, ...(apply ? { apply: true } : {}) }]);
  if (r === undefined || 'error' in r) assert.fail(`dispatch error: ${JSON.stringify(r)}`);
  assert.ok(r.result.ok, `expected ok, got ${JSON.stringify(r)}`);
  return r.result.data as unknown as Envelope;
}

test('move_symbol: a top-level symbol moves A→existing B; aliased importer repointed; cold compile clean', async () => {
  const p = await project({
    'tsconfig.json': TSCONFIG,
    'src/source.ts':
      'export const helper = (x: number): number => x * 2;\n' +
      'export const other = (): number => helper(1);\n',
    'src/dest.ts': 'export const existing = 1;\n',
    // An ALIASED importer (@/source) — the codemaster selling point: grep/textual moves miss it.
    'src/consumer.ts':
      "import { helper } from '@/source';\nexport const use = (): number => helper(2);\n",
  });
  try {
    const dry = await move(p, { name: 'helper', dest: 'src/dest.ts' });
    assert.equal(dry.mode, 'dry-run');
    assert.equal(dry.typecheck.clean, true, `dry typecheck: ${JSON.stringify(dry)}`);
    assert.equal(p.git('status', '--porcelain'), ''); // zero writes on dry-run

    const applied = await move(p, { name: 'helper', dest: 'src/dest.ts' }, true);
    assert.equal(applied.mode, 'applied');
    assert.equal(applied.applied, true, `expected applied, got ${JSON.stringify(applied)}`);
    assert.equal(applied.typecheck.clean, true);
    assert.equal(applied.diff, dry.diff); // diff(dry) === diff(apply)

    // Independent cold compile — helper resolves from its new home everywhere.
    assert.deepEqual(coldTscErrors(p.root), []);
    const dest = readFileSync(path.join(p.root, 'src/dest.ts'), 'utf8');
    assert.match(dest, /export const helper/, 'helper landed in dest');
    assert.match(dest, /export const existing/, 'dest kept its own content');
    const source = readFileSync(path.join(p.root, 'src/source.ts'), 'utf8');
    assert.doesNotMatch(source, /export const helper =/, 'helper removed from source');
    assert.match(source, /import \{ helper \} from/, 'source keeps a back-import (still used)');
    // The aliased importer is repointed to dest — grep/textual moves would miss `@/source`. The LS
    // picks its own specifier style (relative `./dest` here, not alias-preserving); correctness is
    // what matters (cold compile above proves it resolves), so assert it no longer points at source.
    const consumer = readFileSync(path.join(p.root, 'src/consumer.ts'), 'utf8');
    assert.match(consumer, /from ['"](@\/dest|\.\/dest)['"]/, 'aliased importer repointed to dest');
    assert.doesNotMatch(consumer, /source/, 'consumer no longer imports from source');
  } finally {
    await p.dispose();
  }
});

test('move_symbol: §2.8 gate — a move that INTRODUCES a typecheck error is refused, byte-identical', async () => {
  // `helper` uses the source-local `x:number`; dest already declares a top-level `x:string`. The
  // LS must export `x` from source and import it into dest → a duplicate-identifier collision the
  // move INTRODUCES. The moved NAME (`helper`) does not collide, so the pre-check passes and the
  // §2.8 typecheck gate is what must catch it — apply refused, nothing written.
  const before = {
    source: 'const x = 5;\nexport const helper = (): number => x;\n',
    dest: 'export const x = "str";\nexport const existing = 1;\n',
  };
  const p = await project({
    'tsconfig.json': TSCONFIG,
    'src/source.ts': before.source,
    'src/dest.ts': before.dest,
  });
  try {
    const r = await move(p, { name: 'helper', dest: 'src/dest.ts' }, true);
    assert.equal(
      r.typecheck.clean,
      false,
      `expected an introduced error, got ${JSON.stringify(r)}`,
    );
    assert.notEqual(r.mode, 'applied');
    assert.notEqual(r.applied, true);
    assert.equal(p.git('status', '--porcelain'), ''); // zero writes
    assert.equal(readFileSync(path.join(p.root, 'src/source.ts'), 'utf8'), before.source);
    assert.equal(readFileSync(path.join(p.root, 'src/dest.ts'), 'utf8'), before.dest);
  } finally {
    await p.dispose();
  }
});

test('move_symbol: dest name-collision REFUSED before any write', async () => {
  const before = {
    source:
      'export const helper = (): number => 1;\nexport const other = (): number => helper();\n',
    dest: 'export const helper = (): string => "dup";\n',
  };
  const p = await project({
    'tsconfig.json': TSCONFIG,
    'src/source.ts': before.source,
    'src/dest.ts': before.dest,
  });
  try {
    // Target by position — `name:'helper'` is ambiguous (both files declare it), which the
    // resolver rejects first; file:line:col pins the source `helper` so the collision pre-check runs.
    const [r] = await p.request([
      {
        name: 'move_symbol',
        args: { file: 'src/source.ts', line: 1, col: 14, dest: 'src/dest.ts' },
        apply: true,
      },
    ]);
    assert.ok(r !== undefined && 'result' in r && !r.result.ok, 'collision must fail');
    if ('result' in r && !r.result.ok)
      assert.match(r.result.failure.message, /collision|already declares/);
    assert.equal(p.git('status', '--porcelain'), ''); // nothing written
    assert.equal(readFileSync(path.join(p.root, 'src/dest.ts'), 'utf8'), before.dest);
  } finally {
    await p.dispose();
  }
});

test('move_symbol: a NESTED target is refused — never moves the enclosing top-level', async () => {
  const p = await project({
    'tsconfig.json': TSCONFIG,
    'src/form.ts':
      'export const useAppForm = () => {\n' +
      '  const BoundInput = (p: { v: string }): string => p.v;\n' +
      '  return { BoundInput };\n' +
      '};\n',
    'src/dest.ts': 'export const existing = 1;\n',
  });
  try {
    const [r] = await p.request([
      {
        name: 'move_symbol',
        args: { file: 'src/form.ts', line: 2, col: 9, dest: 'src/dest.ts' },
        apply: true,
      },
    ]);
    assert.ok(r !== undefined && 'result' in r && !r.result.ok, 'nested target must refuse');
    if ('result' in r && !r.result.ok) assert.match(r.result.failure.message, /nested|TOP-LEVEL/);
    assert.equal(p.git('status', '--porcelain'), ''); // useAppForm untouched
  } finally {
    await p.dispose();
  }
});

test('move_symbol: dest not in the project fails (use extract_symbol for a new file)', async () => {
  const p = await project({
    'tsconfig.json': TSCONFIG,
    'src/source.ts': 'export const helper = (): number => 1;\n',
  });
  try {
    const [r] = await p.request([
      { name: 'move_symbol', args: { name: 'helper', dest: 'src/brand-new.ts' }, apply: true },
    ]);
    assert.ok(r !== undefined && 'result' in r && !r.result.ok, 'non-existent dest must fail');
    if ('result' in r && !r.result.ok) {
      assert.match(r.result.failure.message, /dest-not-in-project|existing file|extract_symbol/);
    }
    assert.equal(p.git('status', '--porcelain'), ''); // nothing written
  } finally {
    await p.dispose();
  }
});

test('move_symbol: source === dest is refused', async () => {
  const p = await project({
    'tsconfig.json': TSCONFIG,
    'src/source.ts': 'export const helper = (): number => 1;\n',
  });
  try {
    const [r] = await p.request([
      { name: 'move_symbol', args: { name: 'helper', dest: 'src/source.ts' }, apply: true },
    ]);
    assert.ok(r !== undefined && 'result' in r && !r.result.ok, 'same-file move must fail');
    if ('result' in r && !r.result.ok)
      assert.match(r.result.failure.message, /same-file|already lives/);
    assert.equal(p.git('status', '--porcelain'), '');
  } finally {
    await p.dispose();
  }
});

test('move_symbol: a .js dest is refused (edit-accept set == typecheck set, no false-clean)', async () => {
  // A `.js` dest would be EDITED but excluded from the §2.8 overlay/checkPaths (assemble.ts TS_RE),
  // so a TS annotation written into it would read clean. The dest-acceptance regex must refuse it.
  const p = await project({
    'tsconfig.json':
      '{"compilerOptions":{"strict":true,"module":"preserve","allowJs":true,"checkJs":true}}',
    'src/source.ts': 'export const helper = (x: number): number => x * 2;\n',
    'src/dest.js': 'export const existing = 1;\n',
  });
  try {
    const [r] = await p.request([
      { name: 'move_symbol', args: { name: 'helper', dest: 'src/dest.js' }, apply: true },
    ]);
    assert.ok(r !== undefined && 'result' in r && !r.result.ok, '.js dest must be refused');
    if ('result' in r && !r.result.ok)
      assert.match(r.result.failure.message, /not a TypeScript module/);
    assert.equal(p.git('status', '--porcelain'), ''); // nothing written
  } finally {
    await p.dispose();
  }
});

test('move_symbol: when source no longer uses the symbol, NO back-import is added', async () => {
  const p = await project({
    'tsconfig.json': TSCONFIG,
    'src/source.ts':
      'export const helper = (x: number): number => x * 2;\nexport const lone = 1;\n',
    'src/dest.ts': 'export const existing = 1;\n',
    'src/consumer.ts':
      "import { helper } from '@/source';\nexport const use = (): number => helper(2);\n",
  });
  try {
    const applied = await move(p, { name: 'helper', dest: 'src/dest.ts' }, true);
    assert.equal(applied.applied, true, JSON.stringify(applied));
    assert.deepEqual(coldTscErrors(p.root), []);
    const source = readFileSync(path.join(p.root, 'src/source.ts'), 'utf8');
    assert.doesNotMatch(
      source,
      /import .*helper/,
      'source must NOT import helper it no longer uses',
    );
    assert.doesNotMatch(source, /helper/, 'source has no helper reference left');
  } finally {
    await p.dispose();
  }
});

test('move_symbol: a type alias moves; a type-only importer is repointed and stays type-only', async () => {
  const p = await project({
    'tsconfig.json': TSCONFIG,
    'src/source.ts': 'export type Foo = { a: number };\n',
    'src/dest.ts': 'export const existing = 1;\n',
    'src/consumer.ts':
      "import type { Foo } from '@/source';\nexport const f = (x: Foo): number => x.a;\n",
  });
  try {
    const applied = await move(p, { name: 'Foo', dest: 'src/dest.ts' }, true);
    assert.equal(applied.applied, true, JSON.stringify(applied));
    assert.deepEqual(coldTscErrors(p.root), []);
    assert.match(readFileSync(path.join(p.root, 'src/dest.ts'), 'utf8'), /export type Foo/);
    const consumer = readFileSync(path.join(p.root, 'src/consumer.ts'), 'utf8');
    assert.match(consumer, /import type \{ Foo \} from/, 'importer stays type-only');
    assert.doesNotMatch(consumer, /source/, 'importer repointed off source');
  } finally {
    await p.dispose();
  }
});

test('move_symbol: an edit targeting a gitignored-but-compiled importer → honest refusal, zero write', async () => {
  // git-tree↔program desync: the move-tree is git's listing (ls-files: tracked + untracked-not-
  // ignored), but the TS program ALSO compiles GITIGNORED files. The LS "Move to file" repoints
  // the gitignored importer → an edit to a file the plan/rollback machinery has no node for. That
  // must be an HONEST refusal that NAMES the file (and is actionable), never a half-move or a
  // silent edit-to-nowhere (the fail[10] class). Independent oracle: git stays byte-clean.
  const before = {
    source:
      'export const helper = (x: number): number => x * 2;\nexport const other = (): number => 1;\n',
    consumer:
      "import { helper } from '../src/source';\nexport const use = (): number => helper(2);\n",
  };
  const p = await project({
    'tsconfig.json': TSCONFIG,
    '.gitignore': 'generated/\n',
    'src/source.ts': before.source,
    'src/dest.ts': 'export const existing = 1;\n',
    // Gitignored, so EXCLUDED from git ls-files, yet compiled by the default tsconfig include.
    'generated/consumer.ts': before.consumer,
  });
  try {
    const [r] = await p.request([
      { name: 'move_symbol', args: { name: 'helper', dest: 'src/dest.ts' }, apply: true },
    ]);
    assert.ok(
      r !== undefined && 'result' in r && !r.result.ok,
      `desync edit must refuse, got ${JSON.stringify(r)}`,
    );
    if ('result' in r && !r.result.ok) {
      assert.match(r.result.failure.message, /generated\/consumer\.ts/, 'names the offending file');
      assert.match(
        r.result.failure.message,
        /untracked|git-track|excludes/i,
        'the refusal is actionable, not an opaque "unknown file"',
      );
    }
    // Zero write — git stays clean (covers every TRACKED file), and the GITIGNORED importer (which
    // git can't see, the one the desync edit targeted) is byte-unchanged too.
    assert.equal(p.git('status', '--porcelain'), '', 'no tracked file written');
    assert.equal(readFileSync(path.join(p.root, 'generated/consumer.ts'), 'utf8'), before.consumer);
  } finally {
    await p.dispose();
  }
});

test('move_symbol: a re-export barrel of the moved symbol → honest refusal (LS does not repoint barrels)', async () => {
  // KNOWN LIMITATION: the LS "Move to file" rewrites DIRECT importers but NOT `export {X} from`
  // re-export barrels — so the barrel would dangle (`Module '@/source' has no exported member`).
  // The §2.8 gate catches that and REFUSES; nothing is written (honest, never a half-move).
  const before = {
    source: 'export const helper = (): number => 1;\nexport const keep = 2;\n',
    barrel: "export { helper } from '@/source';\n",
  };
  const p = await project({
    'tsconfig.json': TSCONFIG,
    'src/source.ts': before.source,
    'src/dest.ts': 'export const existing = 1;\n',
    'src/index.ts': before.barrel,
    'src/consumer.ts':
      "import { helper } from '@/index';\nexport const use = (): number => helper();\n",
  });
  try {
    const r = await move(p, { name: 'helper', dest: 'src/dest.ts' }, true);
    assert.notEqual(r.applied, true, `barrel re-export must refuse, got ${JSON.stringify(r)}`);
    assert.equal(r.typecheck.clean, false);
    assert.equal(p.git('status', '--porcelain'), ''); // nothing written
    assert.equal(readFileSync(path.join(p.root, 'src/index.ts'), 'utf8'), before.barrel);
    assert.equal(readFileSync(path.join(p.root, 'src/source.ts'), 'utf8'), before.source);
  } finally {
    await p.dispose();
  }
});
