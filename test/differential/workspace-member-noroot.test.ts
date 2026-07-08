// No-root workspace-member discovery (t-816306), oracle-backed (§16). A pnpm/vite monorepo can have
// NO root `tsconfig.json` at all — only a `tsconfig.base.json` (an `extends` fragment, never resolved
// by `findConfigFile('tsconfig.json')`) plus per-package configs (real claude-ui). The primary is
// then UNDEFINED (the "(no tsconfig)" fallback stands in), and `discoverSiblingConfigs` used to
// early-return `[]` whenever the primary was undefined → NONE of the workspace members loaded as
// programs → every cross-package `find_usages`/`find_unused_exports` was floored, the exact monorepo
// pain the feature exists for. The fix seeds member discovery from the workspace manifest
// INDEPENDENTLY of any primary, so members load as independent programs even with no root tsconfig.
//
// These tests pin the fix on hermetic no-root fixtures:
//   (A) members load, the cross-package usage is found + DEDUPED, and — with all members covered and
//       no undiscovered config — the floor lifts (complete:true); cold==warm against a member LS;
//   (B) an alias-only import the fallback CANNOT resolve is found ONLY once the member's own config
//       (with its `paths`) loads — proves no-root discovery does more than un-flag an already-found hit;
//   (C) no workspace manifest → discovery is a NO-OP even with an undefined primary (no over-discovery);
//   (D) SLURP GUARD: a glob-matched dir WITHOUT a package.json is not a member and is not loaded — the
//       package.json-anchoring holds on the undefined-primary path too.
//
// The independent oracle is a fresh-from-cold `ts.LanguageService` over a MEMBER's own tsconfig (a
// DIFFERENT program than the warm daemon composes) — so a cross-program drift would surface.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { project, type TestProject } from '../helpers/project.ts';
import { coldFindReferences } from '../helpers/cold-ls.ts';
import type { OpResult } from '../../src/ops/contracts.ts';

const C = '{"strict":true,"module":"esnext","moduleResolution":"bundler"}';

type Usage = { span: { file: string; line: number; col: number }; role: string };
type UsagesData = {
  usages?: Usage[];
  complete?: boolean;
  undiscoveredPrograms?: string[];
  notes?: string[];
};
function usagesData(r: OpResult): UsagesData {
  assert.ok('result' in r && r.result.ok, JSON.stringify(r));
  return r.result.data as UsagesData;
}
const fileSet = (u: Usage[]): string[] => [...new Set(u.map((x) => x.span.file))].sort();

type UnusedRow = { name: string; confidence: string };
type UnusedData = { unused: UnusedRow[]; undiscoveredPrograms?: string[] };
function unusedData(r: OpResult): UnusedData {
  assert.ok('result' in r && r.result.ok, JSON.stringify(r));
  return r.result.data as UnusedData;
}

test('(A) no-root monorepo: members load, cross-package usage found + DEDUPED, floor lifts (complete:true)', async () => {
  // NO root tsconfig.json and NO base — standalone members wired only by `packages/*`. Pre-fix the
  // undefined primary early-returned [] → both members undiscovered → floored. Post-fix both load.
  const p: TestProject = await project({
    'pnpm-workspace.yaml': "packages:\n  - 'packages/*'\n",
    'package.json': '{"name":"root","private":true}',
    'packages/pkg-a/package.json': '{"name":"pkg-a"}',
    'packages/pkg-a/tsconfig.json': `{"compilerOptions":${C},"include":["src"]}`,
    'packages/pkg-a/src/index.ts': 'export const foo = 1;\n',
    'packages/pkg-b/package.json': '{"name":"pkg-b"}',
    'packages/pkg-b/tsconfig.json': `{"compilerOptions":${C},"include":["src"]}`,
    'packages/pkg-b/src/use.ts':
      "import { foo } from '../../pkg-a/src/index';\nexport const bar = foo + 1;\n",
  });
  try {
    const d = usagesData(await p.op('find_usages', { name: 'foo', collapseImports: false }));
    // With every member discovered + covered and no other repo tsconfig, the floor is empty.
    assert.notEqual(d.complete, false, 'must not be floored once members are discovered');
    assert.deepEqual(d.undiscoveredPrograms ?? [], [], 'both members are discovered, no floor');
    assert.ok(
      !(d.notes ?? []).some((n) => n.includes('LOWER BOUND')),
      'no LOWER-BOUND note once the members load',
    );
    // Dedup (Q4): decl + import + read = exactly 3 sites, NOT 6 (the member program re-finds the same
    // two pkg-b sites; a double-count here would be the never-lie violation).
    const u = d.usages ?? [];
    assert.equal(u.length, 3, `expected 3 deduped sites, got ${u.length}: ${JSON.stringify(u)}`);
    assert.deepEqual(fileSet(u), ['packages/pkg-a/src/index.ts', 'packages/pkg-b/src/use.ts']);

    // find_unused_exports: no floor, and `bar` (dead) is `certain`.
    const ue = unusedData(await p.op('find_unused_exports', {}));
    assert.deepEqual(ue.undiscoveredPrograms ?? [], []);
    const bar = ue.unused.find((x) => x.name === 'bar');
    assert.ok(bar && bar.confidence === 'certain', `bar undemoted: ${JSON.stringify(bar)}`);

    // Independent oracle: a cold LS over pkg-b's OWN config (its program pulls in pkg-a via the
    // relative import) — the ground-truth cross-package reference set for foo.
    const oracle = coldFindReferences(
      p.root,
      'packages/pkg-a/src/index.ts',
      'foo',
      'packages/pkg-b/tsconfig.json',
    );
    assert.deepEqual(
      fileSet(u),
      oracle,
      'warm fan-out matches the cold member oracle (cold==warm)',
    );
  } finally {
    await p.dispose();
  }
});

test('(B) no-root alias-only member the fallback cannot resolve: usage found ONLY after member discovery', async () => {
  // pkg-b imports pkg-a by package NAME via pkg-b's own `paths` alias. The no-tsconfig fallback has
  // NO such alias and (hermetic) no node_modules to resolve it → the import is UNRESOLVED there, so
  // the usage is not counted. Only loading pkg-b's OWN config (with its paths) resolves it — proving
  // no-root member discovery surfaces a genuinely-new hit, not just an un-flagged one.
  const p: TestProject = await project({
    'pnpm-workspace.yaml': "packages:\n  - 'packages/*'\n",
    'package.json': '{"name":"root","private":true}',
    'packages/pkg-a/package.json': '{"name":"pkg-a"}',
    'packages/pkg-a/tsconfig.json': `{"compilerOptions":${C},"include":["src"]}`,
    'packages/pkg-a/src/index.ts': 'export const widget = 1;\n',
    'packages/pkg-b/package.json': '{"name":"pkg-b"}',
    'packages/pkg-b/tsconfig.json': `{"compilerOptions":{"strict":true,"module":"esnext","moduleResolution":"bundler","baseUrl":".","paths":{"pkg-a":["../pkg-a/src/index.ts"]}},"include":["src"]}`,
    'packages/pkg-b/src/use.ts':
      "import { widget as w } from 'pkg-a';\nexport const used = w + 1;\n",
  });
  try {
    const d = usagesData(await p.op('find_usages', { name: 'widget', collapseImports: false }));
    const u = d.usages ?? [];
    assert.ok(
      u.some((x) => x.span.file === 'packages/pkg-b/src/use.ts'),
      `alias usage must be found once pkg-b loads: ${JSON.stringify(u)}`,
    );
    assert.notEqual(d.complete, false);

    // Oracle: cold LS over pkg-b's config (the program whose paths resolve the alias).
    const oracle = coldFindReferences(
      p.root,
      'packages/pkg-a/src/index.ts',
      'widget',
      'packages/pkg-b/tsconfig.json',
    );
    assert.ok(oracle.includes('packages/pkg-b/src/use.ts'), 'oracle confirms the alias ref');
    assert.deepEqual(fileSet(u), oracle, 'warm fan-out matches the cold member oracle');
  } finally {
    await p.dispose();
  }
});

test('(C) no-root + no workspace manifest: discovery is a NO-OP (undefined primary does not over-discover)', async () => {
  // No pnpm-workspace.yaml and no package.json `workspaces` → source 2 yields nothing even though the
  // primary is undefined. A nested config stays undiscovered (the conservative default the slurp risk
  // demands) — so the undefined-primary branch is not a blanket "load every nested tsconfig".
  const p: TestProject = await project({
    'package.json': '{"name":"root","private":true}',
    'packages/pkg-a/package.json': '{"name":"pkg-a"}',
    'packages/pkg-a/tsconfig.json': `{"compilerOptions":${C},"include":["src"]}`,
    'packages/pkg-a/src/index.ts': 'export const thing = 1;\n',
  });
  try {
    const ue = unusedData(await p.op('find_unused_exports', {}));
    assert.ok(
      (ue.undiscoveredPrograms ?? []).includes('packages/pkg-a/tsconfig.json'),
      `with no workspace decl the nested config is NOT auto-discovered: ${JSON.stringify(ue.undiscoveredPrograms)}`,
    );
  } finally {
    await p.dispose();
  }
});

test('(D) no-root SLURP GUARD: a glob-matched dir WITHOUT a package.json is not a member and is not loaded', async () => {
  // `packages/*` matches `packages/decoy`, but decoy has NO package.json → it is a bare tsconfig, not
  // a workspace member, and must NOT be loaded even with an undefined primary. The package.json-anchor
  // holds on the no-root path exactly as it does with a root primary.
  const p: TestProject = await project({
    'pnpm-workspace.yaml': "packages:\n  - 'packages/*'\n",
    'package.json': '{"name":"root","private":true}',
    'packages/real/package.json': '{"name":"real"}',
    'packages/real/tsconfig.json': `{"compilerOptions":${C},"include":["src"]}`,
    'packages/real/src/r.ts': 'export const r = 1;\n',
    'packages/decoy/tsconfig.json': `{"compilerOptions":${C},"include":["src"]}`,
    'packages/decoy/src/d.ts': 'export const d = 1;\n',
  });
  try {
    const ue = unusedData(await p.op('find_unused_exports', {}));
    const undiscovered = ue.undiscoveredPrograms ?? [];
    assert.ok(
      undiscovered.includes('packages/decoy/tsconfig.json'),
      `decoy must remain undiscovered (not loaded as a member): ${JSON.stringify(undiscovered)}`,
    );
    assert.ok(
      !undiscovered.includes('packages/real/tsconfig.json'),
      'the real member IS loaded → not in the undiscovered set',
    );
  } finally {
    await p.dispose();
  }
});
