// §16 invariant 5 made concrete on the traps `find_usages` beats grep on — and the §16
// claim "`find_usages ⊇ grep` does NOT hold" made into assertions in BOTH directions:
//   · alias / barrel / type-only / cross-file → find_usages INCLUDES a semantic site that
//     a word-boundary grep MISSES (the aliased `<B/>` under `import {Button as B}`).
//   · same-named symbols in different scopes → find_usages EXCLUDES the unrelated same-name
//     site that grep INCLUDES (symbol identity, not text — the thing grep cannot do).
//
// The independent oracle is the HAND-CURATED expected site per trap (the fixture is input;
// the ground truth is written here, not read back from a second LS — comparing to a cold
// `findReferences` would be the circular check §16 explicitly forbids). ripgrep is the
// DISTINCTNESS cross-check only, honest-skipped when absent, so every find_usages-side
// assertion stands on its own.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { project, type TestProject } from '../helpers/project.ts';
import { rgSites } from '../helpers/ripgrep.ts';
import type { OpResult } from '../../src/ops/contracts.ts';

type Usage = {
  span: { file: string; line: number; col: number };
  role: string;
  confidence: string;
};

const FILES = {
  'tsconfig.json': '{"compilerOptions":{"strict":true,"jsx":"react-jsx"}}',
  'src/Button.tsx':
    'export interface Props { size: string }\n' +
    'export const Button = (p: Props) => <button>{p.size}</button>;\n',
  'src/App.tsx':
    "import { Button as B } from './Button';\n" + // alias import
    "import type { Props as P } from './Button';\n" + // type-only, aliased
    'export const make = (p: P): string => p.size;\n' + // `: P` — type usage at line 3
    'export const App = () => <B size="lg" />;\n', // `<B/>` — jsx usage at line 4
  'src/index.ts': "export { Button } from './Button';\n", // barrel re-export
  // Two unrelated symbols that share the name `dup` — the precision trap.
  'src/scopeA.ts': 'const dup = 1;\nexport const useA = (): number => dup + 1;\n',
  'src/scopeB.ts': 'const dup = 2;\nexport const useB = (): number => dup + 2;\n',
};

function usagesOf(r: OpResult): Usage[] {
  assert.ok('result' in r && r.result.ok, JSON.stringify(r));
  return (r.result.data as { usages?: Usage[] }).usages ?? [];
}
const has = (u: Usage[], file: string, line: number, role?: string): boolean =>
  u.some(
    (x) => x.span.file === file && x.span.line === line && (role === undefined || x.role === role),
  );
// The EXACT semantic set as `file:line:role` strings, sorted — for set-equality assertions
// (inclusion alone passes a spurious-extra or dropped site, §3 completeness/precision).
const projset = (u: Usage[]): string[] =>
  u.map((x) => `${x.span.file}:${x.span.line}:${x.role}`).sort();

test('alias + barrel + cross-file: find_usages includes sites a word-grep misses', async () => {
  const p: TestProject = await project(FILES);
  try {
    const u = usagesOf(await p.op('find_usages', { name: 'Button', collapseImports: false }));
    // The aliased JSX usage `<B/>` (App.tsx:4) — resolved through `Button as B`, the
    // canonical thing grep cannot follow. And the barrel re-export (index.ts:1).
    assert.ok(has(u, 'src/App.tsx', 4, 'jsx'), 'aliased <B/> usage found semantically');
    assert.ok(has(u, 'src/index.ts', 1, 'reexport'), 'barrel re-export found');

    // §3 completeness + precision: the EXACT hand-curated set, not just inclusion — a spurious
    // extra usage (misidentification) or a dropped site would slip an inclusion-only check.
    assert.deepEqual(
      projset(u),
      [
        // The alias import line carries TWO Button refs at distinct columns — the imported name
        // `Button` and the alias binding `B` — both role 'import'; findReferences reports each.
        // (The alias's USE is the separate jsx site at line 4.)
        'src/App.tsx:1:import',
        'src/App.tsx:1:import',
        'src/App.tsx:4:jsx',
        'src/Button.tsx:2:decl',
        'src/index.ts:1:reexport',
      ].sort(),
      'find_usages returns EXACTLY the hand-read semantic set for Button',
    );

    // Distinctness: a word grep for "Button" never matches App.tsx line 4 (it reads `<B`),
    // yet find_usages has it → find_usages ⊋ grep on that site.
    const rg = rgSites(p.root, 'Button');
    if (rg !== undefined) {
      assert.ok(
        !rg.some((s) => s.file === 'src/App.tsx' && s.line === 4),
        'grep misses the aliased usage line (no literal "Button" there)',
      );
      assert.ok(
        rg.some((s) => s.file === 'src/index.ts'),
        'sanity: grep does see the literal re-export',
      );
    }
  } finally {
    await p.dispose();
  }
});

test('type-only aliased import: the `: P` type usage is found, grep misses it', async () => {
  const p = await project(FILES);
  try {
    const u = usagesOf(await p.op('find_usages', { name: 'Props', collapseImports: false }));
    // `make(p: P)` at App.tsx:3 is a TYPE-position use of Props via the alias P.
    assert.ok(has(u, 'src/App.tsx', 3, 'type'), 'aliased type usage found at the annotation');

    const rg = rgSites(p.root, 'Props');
    if (rg !== undefined) {
      assert.ok(
        !rg.some((s) => s.file === 'src/App.tsx' && s.line === 3),
        'grep misses the `: P` annotation (no literal "Props" on that line)',
      );
    }
  } finally {
    await p.dispose();
  }
});

test('same-named symbols in different scopes: find_usages excludes the unrelated one (grep cannot)', async () => {
  const p = await project(FILES);
  try {
    // Target scopeA's `dup` by position (`const dup` at line 1, col 7).
    const u = usagesOf(
      await p.op('find_usages', { file: 'src/scopeA.ts', line: 1, col: 7, collapseImports: false }),
    );
    const files = new Set(u.map((x) => x.span.file));
    assert.ok(files.has('src/scopeA.ts'), 'the queried symbol’s own refs are present');
    assert.ok(
      !files.has('src/scopeB.ts'),
      'the UNRELATED same-named `dup` in scopeB is excluded — identity, not text',
    );

    // Exact set: scopeA's decl (line 1) + its one read (line 2), and NOTHING else — pins both
    // that scopeB is excluded AND that no spurious site crept in.
    assert.deepEqual(
      projset(u),
      ['src/scopeA.ts:1:decl', 'src/scopeA.ts:2:read'].sort(),
      'find_usages returns EXACTLY scopeA’s own refs',
    );

    // Distinctness the other way: grep for "dup" DOES hit scopeB → find_usages ⊊ grep here.
    const rg = rgSites(p.root, 'dup');
    if (rg !== undefined) {
      assert.ok(
        rg.some((s) => s.file === 'src/scopeB.ts'),
        'grep conflates the two `dup`s (hits scopeB); find_usages did not',
      );
    }
  } finally {
    await p.dispose();
  }
});

test('every semantic usage carries certain confidence (no dynamic hop in static refs)', async () => {
  const p = await project(FILES);
  try {
    const u = usagesOf(await p.op('find_usages', { name: 'Button', collapseImports: false }));
    assert.ok(u.length > 0);
    assert.ok(
      u.every((x) => x.confidence === 'certain'),
      'statically-resolved refs are type-proven, never partial/dynamic',
    );
  } finally {
    await p.dispose();
  }
});
