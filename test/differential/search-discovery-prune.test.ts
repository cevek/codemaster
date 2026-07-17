// Discovery pruning for `search_symbol` navto (t-167395). On a loose-root monorepo the LS fans
// navto across EVERY loaded program (root primary + siblings + members + test configs) → all build
// in one heap → OOM kills the in-process daemon (§1). The fix prunes to the PRIMARY alone WHEN the
// primary's built source set already ⊇ the in-root git source surface (declarations are
// resolution-independent, so a covered sibling adds zero new symbols). It is all-or-nothing and
// must be provably COMPLETE — these two tests are the oracle:
//
//   1. prune ON (loose root subsumes) → the pruned warm answer is byte-identical to a cold
//      WHOLE-REPO navto that does NO pruning (nothing dropped, nothing added).
//   2. prune OFF (partial-glob primary + a sibling whose imported file is NOT globbed by the
//      primary and resolves only via the sibling's own `paths`) → the sibling-only symbol is STILL
//      found. This is THE discriminating case: a naive per-program "skip a program whose glob roots
//      ⊆ covered" test would prune the sibling and silently drop the symbol; the surface-⊇ test
//      leaves pruning OFF because the imported file is in the git surface but NOT a primary source.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { project, type TestProject } from '../helpers/project.ts';
import { coldNavtoNames } from '../helpers/cold-ls.ts';
import type { OpResult } from '../../src/ops/contracts.ts';

const COMPILER = '"strict":true,"module":"esnext","moduleResolution":"bundler"';

type Match = { name: string; span: { file: string; line: number; col: number } };
function matchesOf(r: OpResult): Match[] {
  assert.ok('result' in r && r.result.ok, JSON.stringify(r));
  return (r.result.data as { matches?: Match[] }).matches ?? [];
}
const nameFileSet = (m: Match[]): { name: string; file: string }[] =>
  m
    .map((x) => ({ name: x.name, file: x.span.file }))
    .sort((a, b) => a.name.localeCompare(b.name) || a.file.localeCompare(b.file));

test('prune ON (loose root subsumes): pruned warm search == cold whole-repo navto (nothing dropped/added)', async () => {
  // A loose ROOT tsconfig with NO `include` globs the whole repo → it subsumes every sibling/member,
  // so the primary alone covers the surface and the ~3 other programs are pruned. The distinctive
  // 'Widget' symbols live across the primary, a discovered member package, AND a test-only sibling —
  // all globbed by the loose root, so pruning to the primary must lose none of them.
  const p: TestProject = await project({
    'tsconfig.json': `{"compilerOptions":{${COMPILER}}}`,
    'tsconfig.test.json': `{"compilerOptions":{${COMPILER}},"include":["src","test"]}`,
    'packages/lib/package.json': '{"name":"lib"}',
    'packages/lib/tsconfig.json': `{"compilerOptions":{${COMPILER}},"include":["src"]}`,
    'src/AppWidget.ts': 'export const AppWidget = 1;\n',
    'packages/lib/src/LibWidget.ts': 'export const LibWidget = 2;\n',
    'test/TestWidget.ts': 'export const TestWidget = 3;\n',
  });
  try {
    const warm = nameFileSet(
      matchesOf(await p.op('search_symbol', { query: 'Widget', limit: 100 })),
    );
    // Independent oracle: a cold WHOLE-REPO program (root tsconfig globs everything) with no pruning.
    const oracle = coldNavtoNames(p.root, 'Widget');
    assert.deepEqual(warm, oracle, 'pruned warm navto == cold whole-repo navto');
    // Sanity: the member- and test-declared symbols really are present (not an empty-equals-empty).
    const names = warm.map((x) => x.name);
    assert.ok(names.includes('AppWidget'), 'primary symbol found');
    assert.ok(names.includes('LibWidget'), 'member-package symbol found (loose root globs it)');
    assert.ok(names.includes('TestWidget'), 'test-sibling symbol found (loose root globs it)');
  } finally {
    await p.dispose();
  }
});

test('prune OFF (partial-glob primary): a sibling-only symbol reached via the sibling’s own `paths` is STILL found', async () => {
  // THE discriminating case. The primary globs the member's `src` roots but NOT its `generated/`
  // dir, and has NO `@gen/*` path — so it CANNOT resolve `@gen/g` and never loads `generated/g.ts`.
  // The member program declares `@gen/*` and reaches `generated/g.ts` by import (NOT a glob root, so
  // a per-program glob-subset test would wrongly prune the member). `generated/g.ts` is in the git
  // surface but is NOT a primary source file → surface-⊇ is FALSE → pruning stays OFF → the member
  // program is navto'd → `GadgetWidget` is found. A naive prune would drop it silently (§3.4).
  const p: TestProject = await project({
    'tsconfig.json': `{"compilerOptions":{${COMPILER}},"include":["packages/lib/src"]}`,
    'packages/lib/package.json': '{"name":"lib"}',
    'packages/lib/tsconfig.json': `{"compilerOptions":{${COMPILER},"baseUrl":".","paths":{"@gen/*":["generated/*"]}},"include":["src"]}`,
    'packages/lib/src/a.ts':
      "import { GadgetWidget } from '@gen/g';\nexport const useG = GadgetWidget;\n",
    'packages/lib/generated/g.ts': 'export const GadgetWidget = 1;\n',
  });
  try {
    const m = matchesOf(await p.op('search_symbol', { query: 'GadgetWidget', limit: 100 }));
    assert.ok(
      m.some((x) => x.name === 'GadgetWidget' && x.span.file === 'packages/lib/generated/g.ts'),
      `sibling-only (paths-resolved, non-globbed) symbol must be found — not pruned away: ${JSON.stringify(nameFileSet(m))}`,
    );
  } finally {
    await p.dispose();
  }
});

test('prune OFF (allowJs sibling): a .js-only declaration navto surfaces from an allowJs program is STILL found', async () => {
  // The `.js`/`allowJs` recall gap. The loose ROOT has NO `allowJs` → it globs `.ts` only, so the
  // in-root `.ts` surface (`src/main.ts`) is trivially ⊆ the primary. But navto over an `allowJs`
  // sibling ALSO surfaces `.js` declarations, which the primary never parses. Gate 1 detects the
  // `.js` in the sibling's fileNames → widens the surface to include `scripts/build.js` → the
  // primary lacks it → coverage FALSE → no prune → `buildThingXyz` is found. Without the gate the
  // `.ts`-only surface reads as covered and the JS symbol is silently dropped (§3.6, since the navto
  // path carries no disclosure) — and name-addressed find_definition/find_usages would falsely miss it.
  const p: TestProject = await project({
    'tsconfig.json': `{"compilerOptions":{${COMPILER}}}`,
    'tsconfig.scripts.json': `{"compilerOptions":{${COMPILER},"allowJs":true},"include":["scripts"]}`,
    'src/main.ts': 'export const mainThingXyz = 1;\n',
    'scripts/build.js': 'export function buildThingXyz() {\n  return 1;\n}\n',
  });
  try {
    const m = matchesOf(await p.op('search_symbol', { query: 'ThingXyz', limit: 100 }));
    assert.ok(
      m.some((x) => x.name === 'buildThingXyz' && x.span.file === 'scripts/build.js'),
      `allowJs-sibling .js declaration must be found — not pruned away: ${JSON.stringify(nameFileSet(m))}`,
    );
  } finally {
    await p.dispose();
  }
});
