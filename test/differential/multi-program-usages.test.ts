// Multi-program awareness (spec Task G) made concrete + oracle-backed (§16). The warm LS used to
// load ONE tsconfig, so a symbol used only from a file in a SIBLING program (a `test/**` file
// under `tsconfig.test.json`) read as having NO usage — an agent reads "dead" and deletes live
// code. These tests pin the fix on a two-tsconfig fixture:
//   1. find_usages / importers_of see the test-program usage (cross-program fan-out);
//   2. find_unused_exports does NOT report a test-only-used export, and reports a genuinely-dead
//      one as `certain` AGAIN (the blanket sibling demotion is gone);
//   3. freshness across programs: a test file added/edited after warm is reindexed on read.
//
// The independent oracle is a fresh-from-cold `ts.LanguageService` built over `tsconfig.test.json`
// (the program that actually includes the test files) — NOT the warm daemon's fan-out, so the two
// TS views are independent and a cross-program drift bug would surface. find_usages anchored on the
// SAME (src) program would be circular (§16); the cold oracle here is a DIFFERENT program.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { project, type TestProject } from '../helpers/project.ts';
import { coldFindReferences } from '../helpers/cold-ls.ts';
import type { OpResult } from '../../src/ops/contracts.ts';

const COMPILER = '{"strict":true,"module":"esnext","moduleResolution":"bundler"}';
const FILES = {
  // Primary program: src only — it does NOT see the test files.
  'tsconfig.json': `{"compilerOptions":${COMPILER},"include":["src"]}`,
  // Sibling program: src + test — the program where the test-only usage lives.
  'tsconfig.test.json': `{"compilerOptions":${COMPILER},"include":["src","test"]}`,
  'src/seam.ts':
    'export const nullWatcher = { tick: 0 };\n' + // used ONLY from the test program
    'export const trulyDead = 1;\n' + // used nowhere — genuinely dead
    'export const usedInSrc = 2;\n' + // used within the primary program
    'export const consume = (): number => usedInSrc;\n',
  'test/seam.test.ts':
    "import { nullWatcher } from '../src/seam';\n" + 'export const t = nullWatcher.tick + 1;\n',
};

type Usage = { span: { file: string; line: number; col: number }; role: string };
function usagesOf(r: OpResult): Usage[] {
  assert.ok('result' in r && r.result.ok, JSON.stringify(r));
  return (r.result.data as { usages?: Usage[] }).usages ?? [];
}
const fileSet = (u: Usage[]): string[] => [...new Set(u.map((x) => x.span.file))].sort();

type UnusedRow = { name: string; confidence: string };
function unusedOf(r: OpResult): UnusedRow[] {
  assert.ok('result' in r && r.result.ok, JSON.stringify(r));
  return (r.result.data as { unused: UnusedRow[] }).unused;
}

test('find_usages sees a usage that lives only in a sibling (test) program — matched against a cold tsconfig.test.json oracle', async () => {
  const p: TestProject = await project(FILES);
  try {
    const u = usagesOf(await p.op('find_usages', { name: 'nullWatcher', collapseImports: false }));
    // The whole point: the test-program import is found, not just the declaration.
    assert.ok(
      u.some((x) => x.span.file === 'test/seam.test.ts'),
      'the test/** usage under tsconfig.test.json is found (was: decl only)',
    );

    // Independent oracle: a cold LS over tsconfig.test.json (a DIFFERENT program than the one the
    // warm fan-out anchors on) — the ground-truth file set for this symbol's references.
    const oracle = coldFindReferences(p.root, 'src/seam.ts', 'nullWatcher', 'tsconfig.test.json');
    assert.deepEqual(oracle, ['src/seam.ts', 'test/seam.test.ts'], 'cold oracle ground truth');
    assert.deepEqual(fileSet(u), oracle, 'warm fan-out file set == cold test-program oracle');
  } finally {
    await p.dispose();
  }
});

test('importers_of spans the sibling program — a test-file importer is found', async () => {
  const p: TestProject = await project(FILES);
  try {
    const r = await p.op('importers_of', { module: 'src/seam.ts' });
    assert.ok('result' in r && r.result.ok, JSON.stringify(r));
    const importers = (r.result.data as { importers: { at: string }[] }).importers;
    assert.ok(
      importers.some((i) => i.at.startsWith('test/seam.test.ts')),
      'the test-program importer is found',
    );
  } finally {
    await p.dispose();
  }
});

test('find_unused_exports: a test-only-used export is NOT dead; a genuinely-dead one is `certain` (no blanket sibling demotion)', async () => {
  const p: TestProject = await project(FILES);
  try {
    const unused = unusedOf(await p.op('find_unused_exports', {}));
    const byName = new Map(unused.map((u) => [u.name, u]));

    assert.equal(byName.get('nullWatcher'), undefined, 'used from the test program → not reported');
    assert.equal(byName.get('usedInSrc'), undefined, 'used within src → not reported');
    // The win over the old stopgap: a genuinely-dead export reads `certain` even though a sibling
    // tsconfig exists (the sibling program was searched and proved it dead too).
    assert.equal(byName.get('trulyDead')?.confidence, 'certain', 'genuinely dead → certain');
  } finally {
    await p.dispose();
  }
});

test('freshness across programs: a test file added after warm is reindexed on read (never silent-stale)', async () => {
  const p: TestProject = await project(FILES);
  try {
    // Warm the cross-program state (this builds + queries the sibling program).
    const before = usagesOf(
      await p.op('find_usages', { name: 'nullWatcher', collapseImports: false }),
    );
    assert.ok(!before.some((x) => x.span.file === 'test/added.test.ts'), 'not present yet');

    // Add a NEW test file (watcher silenced in project() — exercises the read-time backstop). It is
    // structural for the test program's glob, not the primary's; the host must re-glob the sibling.
    p.write(
      'test/added.test.ts',
      "import { nullWatcher } from '../src/seam';\nexport const z = nullWatcher.tick;\n",
    );

    const after = usagesOf(
      await p.op('find_usages', { name: 'nullWatcher', collapseImports: false }),
    );
    assert.ok(
      after.some((x) => x.span.file === 'test/added.test.ts'),
      'the added test-program file is reindexed on read and its usage found (no undercount)',
    );
  } finally {
    await p.dispose();
  }
});

test('cold == warm across the multi-program state: an edited then reverted test usage tracks both ways', async () => {
  const p: TestProject = await project(FILES);
  try {
    // Establish the cross-program warm state.
    usagesOf(await p.op('find_usages', { name: 'nullWatcher', collapseImports: false }));

    // Remove the test usage — find_usages must drop it (reindexed on read, not stale).
    p.write('test/seam.test.ts', 'export const t = 1;\n');
    const removed = usagesOf(
      await p.op('find_usages', { name: 'nullWatcher', collapseImports: false }),
    );
    assert.ok(
      !removed.some((x) => x.span.file === 'test/seam.test.ts'),
      'after removing the test import, the usage is gone (warm tracks the sibling edit)',
    );

    // Restore it — the usage reappears (warm == a cold boot over the restored tree).
    p.write('test/seam.test.ts', FILES['test/seam.test.ts']);
    const restored = usagesOf(
      await p.op('find_usages', { name: 'nullWatcher', collapseImports: false }),
    );
    assert.ok(
      restored.some((x) => x.span.file === 'test/seam.test.ts'),
      'restoring the test import brings the usage back',
    );
    const oracle = coldFindReferences(p.root, 'src/seam.ts', 'nullWatcher', 'tsconfig.test.json');
    assert.deepEqual(
      fileSet(restored),
      oracle,
      'warm == cold over the restored multi-program tree',
    );
  } finally {
    await p.dispose();
  }
});

test('find_unused_exports: a dynamic import / `export *` / computed import living ONLY in a sibling program demotes (no false-`certain`)', async () => {
  // Module-graph edges must be collected across ALL programs, not just the primary — else an
  // export reached only by a dynamic `import()` / `export *` / computed import in a `test/**` file
  // reads `certain` dead and an agent deletes a live, dynamically-loaded export (the cardinal sin).
  const p: TestProject = await project({
    'tsconfig.json': `{"compilerOptions":${COMPILER},"include":["src"]}`,
    'tsconfig.test.json': `{"compilerOptions":${COMPILER},"include":["src","test"]}`,
    'src/dyn.ts': 'export const dynOnly = 1;\n',
    'src/star.ts': 'export const starOnly = 2;\n',
    'test/loader.test.ts':
      "export const load = () => import('../src/dyn');\n" + // literal dynamic import of src/dyn
      "export * from '../src/star';\n", // star re-export of src/star
  });
  try {
    const unused = unusedOf(await p.op('find_unused_exports', {}));
    const byName = new Map(unused.map((u) => [u.name, u]));
    assert.equal(
      byName.get('dynOnly')?.confidence,
      'partial',
      'dynamically-imported-from-a-test-file export demotes to partial, never certain',
    );
    assert.equal(
      byName.get('starOnly')?.confidence,
      'partial',
      'export *-from-a-test-file demotes to partial',
    );
  } finally {
    await p.dispose();
  }
});

test('find_unused_scss_classes: a class used only from a sibling (test) program is NOT reported dead', async () => {
  const p: TestProject = await project({
    'tsconfig.json': `{"compilerOptions":${COMPILER},"include":["src"]}`,
    'tsconfig.test.json': `{"compilerOptions":${COMPILER},"include":["src","test"]}`,
    'src/b.module.scss': '.usedInTest { color: red; }\n.deadEverywhere { color: blue; }\n',
    'test/b.test.ts': "import s from '../src/b.module.scss';\nexport const x = s.usedInTest;\n",
  });
  try {
    const r = await p.op('find_unused_scss_classes', {});
    assert.ok('result' in r && r.result.ok, JSON.stringify(r));
    const names = (r.result.data as { unused: { name: string }[] }).unused.map((u) => u.name);
    assert.ok(!names.includes('usedInTest'), 'a test-program s.usedInTest access keeps it alive');
    assert.ok(names.includes('deadEverywhere'), 'a genuinely-unused class is still reported');
  } finally {
    await p.dispose();
  }
});

test('find_unused_i18n_keys: a key used only from a sibling (test) program is NOT reported dead', async () => {
  const config =
    `import { defineConfig } from 'codemaster';\n` +
    `export default defineConfig({ i18n: { locales: ['locales/*.json'], functions: ['t'] } });\n`;
  const p: TestProject = await project({
    'codemaster.config.ts': config,
    'tsconfig.json': `{"compilerOptions":${COMPILER},"include":["src"]}`,
    'tsconfig.test.json': `{"compilerOptions":${COMPILER},"include":["src","test"]}`,
    'locales/en.json': JSON.stringify({ usedInTest: 'hi', deadEverywhere: 'bye' }, null, 2),
    'src/t.ts': 'export const t = (k: string): string => k;\n',
    'test/t.test.ts': "import { t } from '../src/t';\nexport const x = t('usedInTest');\n",
  });
  try {
    const r = await p.op('find_unused_i18n_keys', {});
    assert.ok('result' in r && r.result.ok, JSON.stringify(r));
    const keys = (r.result.data as { unused: { key: string }[] }).unused.map((u) => u.key);
    assert.ok(!keys.includes('usedInTest'), 'a test-program t() call keeps the key alive');
    assert.ok(keys.includes('deadEverywhere'), 'a genuinely-unused key is still reported');
  } finally {
    await p.dispose();
  }
});

test('find_unused_i18n_keys (IDENTITY mode): a key used from a test file is alive even when the configured module ALIAS resolves only under the primary tsconfig', async () => {
  // Regression for the wave-2 cardinal-sin: scanByIdentity must not skip a whole sibling file group
  // when that program can't resolve the configured module ARG. The arg `@/lib/i18n` resolves only
  // under tsconfig.json (it declares the `@/*` path); the test program does NOT, but the test file
  // imports the module via a RELATIVE path that resolves there — so its `t('usedInTest')` is real.
  const config =
    `import { defineConfig } from 'codemaster';\n` +
    `export default defineConfig({ i18n: { locales: ['locales/*.json'], module: '@/lib/i18n', functions: ['t'] } });\n`;
  const p: TestProject = await project({
    'codemaster.config.ts': config,
    // Primary: declares the `@/*` alias the i18n `module` arg uses; src only.
    'tsconfig.json':
      '{"compilerOptions":{"strict":true,"module":"esnext","moduleResolution":"bundler","baseUrl":".","paths":{"@/*":["src/*"]}},"include":["src"]}',
    // Sibling: src + test, NO `paths` — so `@/lib/i18n` does NOT resolve here (the bug trigger).
    'tsconfig.test.json': `{"compilerOptions":${COMPILER},"include":["src","test"]}`,
    'locales/en.json': JSON.stringify({ usedInTest: 'hi', deadEverywhere: 'bye' }, null, 2),
    'src/lib/i18n.ts': 'export const t = (k: string): string => k;\n',
    'test/i18n.test.ts':
      "import { t } from '../src/lib/i18n';\nexport const x = t('usedInTest');\n",
  });
  try {
    const r = await p.op('find_unused_i18n_keys', {});
    assert.ok('result' in r && r.result.ok, JSON.stringify(r));
    const keys = (r.result.data as { unused: { key: string }[] }).unused.map((u) => u.key);
    assert.ok(
      !keys.includes('usedInTest'),
      'identity-mode key used from the test program is alive (sibling group not skipped on arg-resolution miss)',
    );
    assert.ok(keys.includes('deadEverywhere'), 'a genuinely-unused key is still reported');
  } finally {
    await p.dispose();
  }
});

test('importers_of: a same relative specifier in two dirs is resolved by IDENTITY, not raw string (no false-live)', async () => {
  const p: TestProject = await project({
    'tsconfig.json': `{"compilerOptions":${COMPILER},"include":["src"]}`,
    'src/dirA/x.ts': 'export const ax = 1;\n',
    'src/dirB/x.ts': 'export const bx = 2;\n',
    'src/dirA/use.ts': "import { ax } from './x';\nexport const a = ax;\n",
    'src/dirB/use.ts': "import { bx } from './x';\nexport const b = bx;\n",
  });
  try {
    const r = await p.op('importers_of', { module: 'src/dirA/x.ts' });
    assert.ok('result' in r && r.result.ok, JSON.stringify(r));
    const at = (r.result.data as { importers: { at: string }[] }).importers.map((i) => i.at);
    assert.ok(
      at.some((a) => a.startsWith('src/dirA/use.ts')),
      'the real importer (dirA) is found',
    );
    assert.ok(
      !at.some((a) => a.startsWith('src/dirB/use.ts')),
      "dirB's `./x` resolves to a DIFFERENT module — not a false importer",
    );
  } finally {
    await p.dispose();
  }
});

test('find_usages by name resolves a symbol DECLARED only in a sibling (test) program (cross-program search)', async () => {
  const p: TestProject = await project({
    'tsconfig.json': `{"compilerOptions":${COMPILER},"include":["src"]}`,
    'tsconfig.test.json': `{"compilerOptions":${COMPILER},"include":["src","test"]}`,
    'src/keep.ts': 'export const keep = 1;\n',
    'test/helper.ts':
      'export const mkFixture = (): number => 1;\n' + // declared ONLY in the test program
      'export const useFixture = (): number => mkFixture();\n',
  });
  try {
    const r = await p.op('find_usages', { name: 'mkFixture' });
    assert.ok(
      'result' in r && r.result.ok,
      `sibling-declared symbol is name-resolvable: ${JSON.stringify(r)}`,
    );
    const u = (r.result.data as { usages?: Usage[] }).usages ?? [];
    assert.ok(
      u.some((x) => x.span.file === 'test/helper.ts'),
      'its sibling-program usage is found',
    );
  } finally {
    await p.dispose();
  }
});
