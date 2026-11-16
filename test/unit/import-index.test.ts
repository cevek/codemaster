// The reverse-import index behind `importersOf` (t-006194). Two properties, each discriminating:
//
//   (a) SCALE — the import graph is resolved ONCE per program state, not once per `importersOf` call.
//       `affected` calls importersOf per closure node; a per-call re-resolution scaled as nodes ×
//       repo imports (759 × ~290 ms on a pnpm monorepo). Counted as filesystem probes (`ts.sys`
//       fileExists / realpath — what module resolution and path identity cost), so a regression to
//       per-call work is a count, not a timing.
//   (b) FRESHNESS — a reindex is never answered from the old index (§3.1), including a resolution
//       input that leaves the Program object unchanged (a `package.json` `types` edit). Oracle: the
//       edited files' text — the import we just wrote must appear, the one we removed must not.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import ts from 'typescript';
import type { RepoRelPath } from '../../src/core/brands.ts';
import { createTsProjectHost, type TsProjectHost } from '../../src/plugins/ts/ls-host.ts';
import { findImporters } from '../../src/plugins/ts/importers.ts';
import { createImportIndexCache } from '../../src/plugins/ts/import-index.ts';

function repo(files: Record<string, string>): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'cm-import-index-'));
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    writeFileSync(path.join(dir, rel), content);
  }
  return dir;
}

const FILES = {
  'tsconfig.json':
    '{"compilerOptions":{"strict":true,"module":"esnext","moduleResolution":"bundler"}}',
  'src/a.ts': 'export const a = 1;\n',
  'src/b.ts': "import { a } from './a';\nexport const b = a;\n",
  'src/c.ts': "import { b } from './b';\nexport { a } from './a';\nexport const c = b;\n",
  'src/d.ts': "import { c } from './c';\nexport const d = c;\n",
};

/** Count filesystem probes through `ts.sys` (module resolution's fileExists, path identity's
 *  realpath) while `fn` runs. */
function probes(fn: () => void): number {
  const sys = ts.sys as { fileExists: typeof ts.sys.fileExists; realpath?: typeof ts.sys.realpath };
  const { fileExists, realpath } = sys;
  let n = 0;
  sys.fileExists = (p) => (n++, fileExists(p));
  if (realpath !== undefined) sys.realpath = (p) => (n++, realpath(p));
  try {
    fn();
  } finally {
    sys.fileExists = fileExists;
    if (realpath !== undefined) sys.realpath = realpath;
  }
  return n;
}

const atFiles = (h: TsProjectHost, cache: ReturnType<typeof createImportIndexCache>, m: string) =>
  findImporters(h, m, cache)
    .importers.map((r) => r.at.split(':')[0])
    .sort();

test('importersOf: N calls on one program state resolve the import graph once (t-006194 scale guard)', () => {
  const dir = repo(FILES);
  try {
    const host = createTsProjectHost(dir);
    const cache = createImportIndexCache();
    host.programs(); // warm, so only the queries are counted

    const first = probes(() =>
      assert.deepEqual(atFiles(host, cache, 'src/a.ts'), ['src/b.ts', 'src/c.ts']),
    );
    // Every later call costs the same constant (resolve + canonicalize the TARGET), however many
    // imports the repo has: one more call must not add one probe per import.
    const second = probes(() => assert.deepEqual(atFiles(host, cache, 'src/b.ts'), ['src/c.ts']));
    const third = probes(() => {
      assert.deepEqual(atFiles(host, cache, 'src/c.ts'), ['src/d.ts']);
      assert.deepEqual(atFiles(host, cache, 'src/d.ts'), []);
    });
    assert.ok(first > second, `the first call builds the index (first=${first}, later=${second})`);
    assert.ok(second <= 3, `a warm call re-probed the repo: ${second} fs probes`);
    assert.equal(third, 2 * second, 'each warm call costs the same constant');
    host.dispose();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('importersOf: an edit (new Program) is answered from a fresh index, never the old one', () => {
  const dir = repo(FILES);
  try {
    const host = createTsProjectHost(dir);
    const cache = createImportIndexCache();
    assert.deepEqual(atFiles(host, cache, 'src/a.ts'), ['src/b.ts', 'src/c.ts']);

    // d.ts now imports a directly instead of c; b.ts drops its import of a.
    writeFileSync(path.join(dir, 'src/d.ts'), "import { a } from './a';\nexport const d = a;\n");
    writeFileSync(path.join(dir, 'src/b.ts'), 'export const b = 2;\n');
    host.reindex(['src/d.ts', 'src/b.ts'] as RepoRelPath[]);

    assert.deepEqual(atFiles(host, cache, 'src/a.ts'), ['src/c.ts', 'src/d.ts']);
    assert.deepEqual(atFiles(host, cache, 'src/c.ts'), []);
    host.dispose();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('importersOf: a package.json `types` edit (same Program object) re-resolves', () => {
  const dir = repo({
    'tsconfig.json':
      '{"compilerOptions":{"strict":true,"module":"esnext","moduleResolution":"bundler"}}',
    'dep/package.json': '{"name":"dep","types":"a.ts"}',
    'dep/a.ts': 'export const x = 1;\n',
    'dep/b.ts': 'export const x = 2;\n',
    'consumer.ts': "import { x } from './dep';\nexport const y = x;\n",
  });
  try {
    const host = createTsProjectHost(dir);
    const cache = createImportIndexCache();
    assert.deepEqual(atFiles(host, cache, 'dep/a.ts'), ['consumer.ts']);
    assert.deepEqual(atFiles(host, cache, 'dep/b.ts'), []);

    writeFileSync(path.join(dir, 'dep/package.json'), '{"name":"dep","types":"b.ts"}');
    host.reindex(['dep/package.json'] as RepoRelPath[]);

    assert.deepEqual(atFiles(host, cache, 'dep/a.ts'), []);
    assert.deepEqual(atFiles(host, cache, 'dep/b.ts'), ['consumer.ts']);
    host.dispose();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('importersOf: an unresolvable target still matches by literal specifier', () => {
  const dir = repo({
    ...FILES,
    'src/style.ts': "import './missing.css';\nimport { a } from './a';\nexport const s = a;\n",
  });
  try {
    const host = createTsProjectHost(dir);
    const view = findImporters(host, './missing.css', createImportIndexCache());
    assert.equal(view.resolved, false);
    assert.deepEqual(
      view.importers.map((r) => r.at),
      ['src/style.ts:1'],
    );
    host.dispose();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
