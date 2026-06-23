// `affected` — changed files → impacted tests, via the ts import graph. Oracle (§16): an
// INDEPENDENT cold reverse-import walk — a fresh `ts.Program`, raw `ts.resolveModuleName`
// (so tsconfig `paths` aliases resolve exactly as the compiler sees them), inverted to an
// importer map, BFS'd from the changed set, then projected to test files. Never the warm
// daemon's own `importersOf` (that would be circular). The changed set for the headline
// case comes from a REAL `git diff` (a working-tree mutation of the committed fixture);
// the focused honesty cases (deleted / untraced / cycle / alias) drive the explicit
// `files` arg. Each assertion is discriminating: transitive depth-3 inclusion catches a
// direct-importers-only bug, the excluded unrelated test catches over-claim, deleted /
// untraced catch the under-report (complete:false) honesty.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import ts from 'typescript';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { project } from '../helpers/project.ts';
import type { OpResult } from '../../src/ops/contracts.ts';
import { matchesAnyGlob } from '../../src/common/glob/match.ts';

const TEST_GLOBS = [
  '**/*.test.ts',
  '**/*.test.tsx',
  '**/*.spec.ts',
  '**/test/**',
  '**/tests/**',
  '**/__tests__/**',
];

const TSCONFIG = JSON.stringify({
  compilerOptions: { strict: true, baseUrl: '.', paths: { '@/*': ['src/*'] } },
});

// A 3-deep dependency chain + a direct test + a transitive test (via a `@/` alias) + an
// unrelated pair. Changing `src/a.ts` must reach `a.test.ts` (depth 1) and `c.test.ts`
// (depth 3, c.test → c → b → a), never `unrelated.test.ts`.
const GRAPH = {
  'tsconfig.json': TSCONFIG,
  'src/a.ts': 'export const a = 1;\n',
  'src/b.ts': "import { a } from './a';\nexport const b = a + 1;\n",
  'src/c.ts': "import { b } from './b';\nexport const c = b + 1;\n",
  'src/a.test.ts': "import { a as z } from './a';\nexport const ta = z;\n",
  'src/c.test.ts': "import { c } from '@/c';\nexport const tc = c;\n",
  'src/unrelated.ts': 'export const u = 1;\n',
  'src/unrelated.test.ts': "import { u } from './unrelated';\nexport const tu = u;\n",
  'notes.md': '# notes\n',
};

interface AffectedData {
  summary: { affectedTests: number; changedFiles: number; complete: boolean };
  notes: string[];
  changeSet: {
    mode: string;
    traced: number;
    untraced?: string[];
    deleted?: string[];
    undiscoveredPrograms?: string[];
  };
  tests: string[];
}

function dataOf(r: OpResult): AffectedData {
  assert.ok('result' in r && r.result.ok, JSON.stringify(r));
  return r.result.data as unknown as AffectedData;
}

/** Independent oracle: the test files transitively reachable (reverse imports) from
 *  `changed`, ∪ the changed files that are themselves tests. Built on a cold Program +
 *  raw module resolution — no codemaster code on the import-graph path. */
function coldAffectedTests(
  root: string,
  changed: readonly string[],
  configRel = 'tsconfig.json',
): string[] {
  const configPath = path.join(root, configRel);
  const json = ts.parseConfigFileTextToJson(configPath, readFileSync(configPath, 'utf8'));
  const parsed = ts.parseJsonConfigFileContent(json.config, ts.sys, root);
  const host = ts.createCompilerHost(parsed.options);
  const program = ts.createProgram(parsed.fileNames, parsed.options, host);
  const rel = (abs: string): string => path.relative(root, abs).split(path.sep).join('/');

  // imported-file → set of files that import it.
  const importers = new Map<string, Set<string>>();
  const addEdge = (imported: string, importer: string): void => {
    const set = importers.get(imported) ?? new Set<string>();
    set.add(importer);
    importers.set(imported, set);
  };
  for (const sf of program.getSourceFiles()) {
    if (sf.isDeclarationFile || !sf.fileName.startsWith(root)) continue;
    const from = rel(sf.fileName);
    for (const stmt of sf.statements) {
      let spec: string | undefined;
      if (ts.isImportDeclaration(stmt) && ts.isStringLiteral(stmt.moduleSpecifier)) {
        spec = stmt.moduleSpecifier.text;
      } else if (
        ts.isExportDeclaration(stmt) &&
        stmt.moduleSpecifier !== undefined &&
        ts.isStringLiteral(stmt.moduleSpecifier)
      ) {
        spec = stmt.moduleSpecifier.text;
      }
      if (spec === undefined) continue;
      const resolved = ts.resolveModuleName(spec, sf.fileName, parsed.options, host).resolvedModule;
      if (resolved === undefined) continue;
      const to = rel(resolved.resolvedFileName);
      if (!to.startsWith('..')) addEdge(to, from);
    }
  }

  const reached = new Set<string>();
  const queue = [...changed];
  while (queue.length > 0) {
    const cur = queue.shift();
    if (cur === undefined) continue;
    for (const imp of importers.get(cur) ?? new Set<string>()) {
      if (!reached.has(imp)) {
        reached.add(imp);
        queue.push(imp);
      }
    }
  }
  const out = new Set<string>();
  for (const f of reached) if (matchesAnyGlob(f, TEST_GLOBS)) out.add(f);
  for (const f of changed) if (matchesAnyGlob(f, TEST_GLOBS)) out.add(f);
  return [...out].sort();
}

test('affected: real git diff → transitive tests, oracle-confirmed, unrelated excluded', async () => {
  const p = await project(GRAPH);
  try {
    // A real working-tree mutation — the changed set comes from `git status`, not an arg.
    p.write('src/a.ts', 'export const a = 1; // touched\n');
    const data = dataOf(await p.op('affected', { testGlobs: TEST_GLOBS }));

    const oracle = coldAffectedTests(p.root, ['src/a.ts']);
    assert.deepEqual(data.tests, oracle, `op vs cold oracle: ${JSON.stringify(data.tests)}`);
    // Discriminators: transitive depth-3 inclusion + over-claim exclusion.
    assert.ok(data.tests.includes('src/a.test.ts'), 'direct test included');
    assert.ok(data.tests.includes('src/c.test.ts'), 'transitive (depth-3) test included');
    assert.ok(!data.tests.includes('src/unrelated.test.ts'), 'unrelated test excluded');
    assert.equal(data.summary.complete, true, 'no cap/deleted/untraced → complete');
  } finally {
    await p.dispose();
  }
});

test('affected: deleted changed file → flagged, complete:false, importers not traced', async () => {
  const p = await project(GRAPH);
  try {
    p.remove('src/b.ts'); // c.ts importer can no longer be traced from the post-change tree
    const data = dataOf(await p.op('affected', { testGlobs: TEST_GLOBS }));

    assert.deepEqual(data.changeSet.deleted, ['src/b.ts']);
    assert.equal(data.summary.complete, false, 'a deletion makes the set a lower bound');
    assert.ok(
      data.notes.some((n) => n.includes('DELETED')),
      'deleted note present',
    );
  } finally {
    await p.dispose();
  }
});

test('affected: untraced (non-TS) and deleted classification via files arg', async () => {
  const p = await project(GRAPH);
  try {
    // notes.md exists on disk but is outside the TS program → untraced.
    // src/ghost.ts is neither in the program nor on disk → deleted.
    const data = dataOf(
      await p.op('affected', { files: ['notes.md', 'src/ghost.ts'], testGlobs: TEST_GLOBS }),
    );
    assert.deepEqual(data.changeSet.untraced, ['notes.md']);
    assert.deepEqual(data.changeSet.deleted, ['src/ghost.ts']);
    assert.equal(data.summary.complete, false);
    assert.equal(data.tests.length, 0, 'neither input reaches a test');
  } finally {
    await p.dispose();
  }
});

test('affected: §3.4 floor — a test in an UNDISCOVERED nested tsconfig is not traced → complete:false + named, never a silent skip', async () => {
  // packages/app/tsconfig.json is neither adjacent to the root config nor referenced, so
  // codemaster never loads it as a program → its test is invisible to importersOf.
  const p = await project({
    'tsconfig.json':
      '{"compilerOptions":{"strict":true,"module":"esnext","moduleResolution":"bundler"},"include":["src"]}',
    'src/a.ts': 'export const a = 1;\n',
    'packages/app/tsconfig.json':
      '{"compilerOptions":{"strict":true,"module":"esnext","moduleResolution":"bundler"}}',
    'packages/app/sub.test.ts': "import { a } from '../../src/a';\nexport const t = a;\n",
  });
  try {
    const data = dataOf(await p.op('affected', { files: ['src/a.ts'], testGlobs: TEST_GLOBS }));

    // The op CANNOT see the undiscovered test → it is absent from the traced set.
    assert.ok(
      !data.tests.includes('packages/app/sub.test.ts'),
      'undiscovered test is not in the traced set (invisible to importersOf)',
    );
    // Independent oracle: a cold walk that DOES load the nested config finds the test —
    // proving the gap is real and the op is honestly UNDER-reporting, not complete.
    const oracle = coldAffectedTests(p.root, ['src/a.ts'], 'packages/app/tsconfig.json');
    assert.deepEqual(
      oracle,
      ['packages/app/sub.test.ts'],
      'cold ground truth: the undiscovered package DOES have a test depending on a.ts',
    );
    // The floor: complete:false and the config NAMED, never a silent false-complete.
    assert.equal(data.summary.complete, false, 'undiscovered config forces complete:false');
    assert.deepEqual(data.changeSet.undiscoveredPrograms, ['packages/app/tsconfig.json']);
    assert.ok(
      data.notes.some((n) => n.includes('NOT loaded as programs')),
      'a named undiscovered-program note is present',
    );
  } finally {
    await p.dispose();
  }
});

test('affected: a DELETED changed test is not listed as a test to run', async () => {
  const p = await project(GRAPH);
  try {
    p.remove('src/a.test.ts'); // a test file, deleted — it no longer exists to run
    const data = dataOf(await p.op('affected', { testGlobs: TEST_GLOBS }));
    assert.deepEqual(data.changeSet.deleted, ['src/a.test.ts']);
    assert.ok(
      !data.tests.includes('src/a.test.ts'),
      'a deleted test is excluded from the run set (not added via the changed-self union)',
    );
    assert.equal(data.summary.complete, false);
  } finally {
    await p.dispose();
  }
});

test('affected: import cycle terminates (visited-set), no hang', async () => {
  const p = await project({
    'tsconfig.json': TSCONFIG,
    // x ⇄ y mutual import; x.test imports x.
    'src/x.ts': "import { y } from './y';\nexport const x = (): number => y();\n",
    // y imports x (closing the cycle); the unused binding is not a tsc error (no noUnusedLocals).
    'src/y.ts':
      "import { x } from './x';\nexport const y = (): number => (typeof x === 'function' ? 2 : 2);\n",
    'src/x.test.ts': "import { x } from './x';\nexport const tx = x;\n",
  });
  try {
    const data = dataOf(await p.op('affected', { files: ['src/x.ts'], testGlobs: TEST_GLOBS }));
    const oracle = coldAffectedTests(p.root, ['src/x.ts']);
    assert.deepEqual(data.tests, oracle);
    assert.ok(data.tests.includes('src/x.test.ts'), 'x.test reached through the cycle');
    assert.equal(data.summary.complete, true);
  } finally {
    await p.dispose();
  }
});
