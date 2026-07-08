// Workspace-member tsconfig discovery (spec Task G / dogfood-jul Ask 1), oracle-backed (§16). A
// pnpm/vite monorepo wires packages by workspace GLOBS (`packages/*`), not tsconfig `references`, so
// a member's tsconfig was neither adjacent to the primary nor referenced → UNDISCOVERED → every
// cross-package `find_usages`/`find_unused_exports` was floored (`complete:false` + `!! LOWER BOUND`,
// or a blanket demotion of dead-export claims) EVEN when the hits were already present via the loose
// primary. These tests pin the fix on hermetic pnpm-workspace fixtures:
//   (a) loose-root relative import: the floor lifts AND the fan-out DEDUPS (count stays N, not 2N);
//   (b) alias-only import the primary can NOT resolve: the usage is GENUINELY missed on the
//       loose primary and found ONLY once the member's own config (with its `paths`) loads —
//       proves the feature does more than un-flag an already-found hit;
//   (c) a Vite-style member (`tsconfig.json` = references hub + `tsconfig.app.json` holds the files):
//       the member config is picked up by dir-match, not just its plain `tsconfig.json`;
//   (d) SLURP GUARD: a decoy `tsconfig.json` under a glob-matched path but WITHOUT a `package.json`
//       is NOT a member and is NOT loaded (membership is package.json-anchored, not dir-glob alone).
//
// The independent oracle is a fresh-from-cold `ts.LanguageService` over the MEMBER's own tsconfig
// (a DIFFERENT program than the warm daemon's primary) — so a cross-program drift would surface.

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

test('(a) loose-root member: floor lifts, usages are DEDUPED (not double-counted)', async () => {
  const p: TestProject = await project({
    'pnpm-workspace.yaml': "packages:\n  - 'packages/*'\n",
    'package.json': '{"name":"root","private":true}',
    // Loose root globs ALL packages → the cross-pkg hit is present via the primary too, so this is
    // the found-but-floored case AND the dedup risk (the member program re-emits the same sites).
    'tsconfig.json': `{"compilerOptions":${C},"include":["packages"]}`,
    'packages/pkg-a/package.json': '{"name":"pkg-a"}',
    'packages/pkg-a/tsconfig.json': `{"compilerOptions":${C},"include":["src"]}`,
    'packages/pkg-a/src/foo.ts': 'export const foo = 1;\n',
    'packages/pkg-b/package.json': '{"name":"pkg-b"}',
    'packages/pkg-b/tsconfig.json': `{"compilerOptions":${C},"include":["src"]}`,
    'packages/pkg-b/src/bar.ts':
      "import { foo } from '../../pkg-a/src/foo';\nexport const bar = foo + 1;\n",
  });
  try {
    const d = usagesData(await p.op('find_usages', { name: 'foo', collapseImports: false }));
    // The floor is gone: no undiscovered program, no LOWER-BOUND note, complete is not false.
    assert.notEqual(d.complete, false, 'must not be floored once pkg-b is discovered');
    assert.deepEqual(d.undiscoveredPrograms ?? [], [], 'pkg-b config is now discovered');
    assert.ok(
      !(d.notes ?? []).some((n) => n.includes('LOWER BOUND')),
      'no LOWER-BOUND note once the member loads',
    );
    // Q4 dedup: decl + import + read = exactly 3 sites, NOT 6 (the member program re-finds the same
    // two bar.ts sites; a double-count here would be the never-lie violation).
    const u = d.usages ?? [];
    assert.equal(u.length, 3, `expected 3 deduped sites, got ${u.length}: ${JSON.stringify(u)}`);
    assert.deepEqual(fileSet(u), ['packages/pkg-a/src/foo.ts', 'packages/pkg-b/src/bar.ts']);

    // find_unused_exports: bar (dead) is `certain` again — the blanket demotion is gone.
    const ue = unusedData(await p.op('find_unused_exports', {}));
    assert.deepEqual(ue.undiscoveredPrograms ?? [], []);
    const bar = ue.unused.find((x) => x.name === 'bar');
    assert.ok(bar && bar.confidence === 'certain', `bar undemoted: ${JSON.stringify(bar)}`);

    // Independent oracle: a cold LS over the loose ROOT config (a DIFFERENT program than the warm
    // fan-out anchors on, and the one whose glob includes BOTH packages) — the ground-truth file set.
    const oracle = coldFindReferences(p.root, 'packages/pkg-a/src/foo.ts', 'foo', 'tsconfig.json');
    assert.deepEqual(fileSet(u), oracle, 'warm fan-out matches the cold whole-repo oracle');
  } finally {
    await p.dispose();
  }
});

test('(b) alias-only member the primary cannot resolve: usage GENUINELY missed on main, found after discovery', async () => {
  // pkg-b imports pkg-a by its package NAME via pkg-b's own `paths` alias. The loose ROOT tsconfig
  // globs pkg-b's file but has NO such alias → on the primary the import is UNRESOLVED, so the usage
  // is not counted there. Only loading pkg-b's OWN config (with its paths) resolves it.
  const p: TestProject = await project({
    'pnpm-workspace.yaml': "packages:\n  - 'packages/*'\n",
    'package.json': '{"name":"root","private":true}',
    'tsconfig.json': `{"compilerOptions":${C},"include":["packages"]}`,
    'packages/pkg-a/package.json': '{"name":"pkg-a"}',
    'packages/pkg-a/tsconfig.json': `{"compilerOptions":${C},"include":["src"]}`,
    'packages/pkg-a/src/index.ts': 'export const widget = 1;\n',
    'packages/pkg-b/package.json': '{"name":"pkg-b"}',
    'packages/pkg-b/tsconfig.json': `{"compilerOptions":{"strict":true,"module":"esnext","moduleResolution":"bundler","baseUrl":".","paths":{"pkg-a":["../pkg-a/src/index.ts"]}},"include":["src"]}`,
    // Rename on import so the local binding is `w`, not `widget` — keeps the by-name `widget` lookup
    // unambiguous (the import specifier `widget` is a reference to the decl, not a second decl).
    'packages/pkg-b/src/use.ts':
      "import { widget as w } from 'pkg-a';\nexport const used = w + 1;\n",
  });
  try {
    const d = usagesData(await p.op('find_usages', { name: 'widget', collapseImports: false }));
    const u = d.usages ?? [];
    // The alias usage in pkg-b IS found — impossible without loading pkg-b's own config.
    assert.ok(
      u.some((x) => x.span.file === 'packages/pkg-b/src/use.ts'),
      `alias usage must be found once pkg-b loads: ${JSON.stringify(u)}`,
    );
    assert.notEqual(d.complete, false);

    // Oracle: cold LS over pkg-b's config (the program whose paths resolve the alias) — the ground
    // truth for widget's cross-package reference set.
    const oracle = coldFindReferences(
      p.root,
      'packages/pkg-a/src/index.ts',
      'widget',
      'packages/pkg-b/tsconfig.json',
    );
    assert.ok(oracle.includes('packages/pkg-b/src/use.ts'), 'oracle confirms the alias ref');
  } finally {
    await p.dispose();
  }
});

test('(c) Vite-style member: tsconfig.app.json (holds files) is discovered by dir-match, not only tsconfig.json', async () => {
  // The member's plain `tsconfig.json` is a references-only hub with NO files; the actual sources
  // live under `tsconfig.app.json`. Matching ALL member-dir `tsconfig*.json` (not just tsconfig.json)
  // loads the app config directly, so the usage under it is seen.
  const p: TestProject = await project({
    'pnpm-workspace.yaml': "packages:\n  - 'apps/*'\n",
    'package.json': '{"name":"root","private":true}',
    'tsconfig.json': `{"compilerOptions":${C},"include":["src"]}`,
    'src/lib.ts': 'export const shared = 1;\n',
    'apps/web/package.json': '{"name":"web"}',
    // Hub: references only, includes nothing itself.
    'apps/web/tsconfig.json': '{"files":[],"references":[{"path":"./tsconfig.app.json"}]}',
    'apps/web/tsconfig.app.json': `{"compilerOptions":${C},"include":["app"]}`,
    'apps/web/app/main.ts':
      "import { shared } from '../../../src/lib';\nexport const m = shared + 1;\n",
  });
  try {
    const d = usagesData(await p.op('find_usages', { name: 'shared', collapseImports: false }));
    const u = d.usages ?? [];
    assert.ok(
      u.some((x) => x.span.file === 'apps/web/app/main.ts'),
      `the app-program usage is found: ${JSON.stringify(u)}`,
    );
    assert.deepEqual(d.undiscoveredPrograms ?? [], [], 'no floor: the member app config loaded');
  } finally {
    await p.dispose();
  }
});

test('(d) SLURP GUARD: a glob-matched dir WITHOUT a package.json is not a member and is not loaded', async () => {
  // `packages/*` matches `packages/decoy`, but decoy has NO package.json — it is a bare tsconfig
  // (a fixture / sub-project), NOT a workspace member. It must NOT be loaded as a sibling program,
  // and — being a repo tsconfig that is genuinely undiscovered — it must still FLOOR honestly.
  const p: TestProject = await project({
    'pnpm-workspace.yaml': "packages:\n  - 'packages/*'\n",
    'package.json': '{"name":"root","private":true}',
    'tsconfig.json': `{"compilerOptions":${C},"include":["src"]}`,
    'src/lib.ts': 'export const thing = 1;\n',
    // A real member — loaded.
    'packages/real/package.json': '{"name":"real"}',
    'packages/real/tsconfig.json': `{"compilerOptions":${C},"include":["src"]}`,
    'packages/real/src/r.ts': 'export const r = 1;\n',
    // A DECOY: matches `packages/*` but has NO package.json → not a member.
    'packages/decoy/tsconfig.json': `{"compilerOptions":${C},"include":["src"]}`,
    'packages/decoy/src/d.ts': 'export const d = 1;\n',
  });
  try {
    // The decoy stays UNDISCOVERED (a bare repo tsconfig, not a loaded member) → find_unused_exports
    // still names it and floors, proving it was NOT slurped as a member program.
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

test('(f) COVERAGE FLOOR: an empty-`include`, no-`references` member covers NOTHING → it stays floored (not falsely subtracted), so a primary export used only from its uncovered stray file is NOT reported certain-dead', async () => {
  // Residual #2 (the one honest→lying edge): a workspace MEMBER (package.json + glob-matched dir) is
  // discovered/loaded, but its tsconfig has an EMPTY `include` and NO `references` → its own built
  // program globs zero files, and the primary (`include:["src"]`) does not glob the member's dir
  // either. So `packages/orphan/src/o.ts` — which imports `thing` from the primary — lives in NO
  // program. Subtracting the member config from the undiscovered floor (the pre-fix behaviour) would
  // flip complete → `certain`-dead for `thing`, a §3.4 completeness LIE. The coverage-proof keeps the
  // member FLOORED: `configCoversFiles` is false (no files, no references), so it is NOT subtracted.
  const p: TestProject = await project({
    'pnpm-workspace.yaml': "packages:\n  - 'packages/*'\n",
    'package.json': '{"name":"root","private":true}',
    'tsconfig.json': `{"compilerOptions":${C},"include":["src"]}`, // does NOT glob packages/*
    'src/lib.ts': 'export const thing = 1;\n', // dead in every LOADED program; used only from o.ts
    // A real MEMBER (package.json → discovered) whose tsconfig covers NOTHING: empty include, no refs.
    'packages/orphan/package.json': '{"name":"orphan"}',
    'packages/orphan/tsconfig.json': `{"compilerOptions":${C},"include":[]}`,
    // A stray source file the member's config does not glob and the primary does not glob → it lives
    // in NO program. It references `thing`, so a false subtraction would wrongly call `thing` dead.
    'packages/orphan/src/o.ts':
      "import { thing } from '../../../src/lib';\nexport const usesThing = thing + 1;\n",
  });
  try {
    // find_unused_exports: the orphan member STAYS in the undiscovered floor (proving it was NOT
    // falsely subtracted), and `thing` — genuinely dead across every LOADED program — is demoted to
    // `partial`, never `certain` (the floor is non-empty). certain-dead here would be the lie.
    const ue = unusedData(await p.op('find_unused_exports', {}));
    assert.ok(
      (ue.undiscoveredPrograms ?? []).includes('packages/orphan/tsconfig.json'),
      `the zero-coverage member must stay floored, not subtracted: ${JSON.stringify(ue.undiscoveredPrograms)}`,
    );
    const thing = ue.unused.find((x) => x.name === 'thing');
    assert.ok(
      thing && thing.confidence === 'partial',
      `thing demoted to partial by the non-empty floor, never certain: ${JSON.stringify(thing)}`,
    );

    // find_usages on the primary symbol STAYS complete:false (floored) + names the undiscovered
    // member — never a claimed-complete result over a search that misses the orphan's stray file.
    const d = usagesData(await p.op('find_usages', { name: 'thing', collapseImports: false }));
    assert.equal(
      d.complete,
      false,
      'find_usages must stay floored while a zero-coverage member exists',
    );
    assert.ok(
      (d.undiscoveredPrograms ?? []).includes('packages/orphan/tsconfig.json'),
      `find_usages names the floored member: ${JSON.stringify(d.undiscoveredPrograms)}`,
    );
  } finally {
    await p.dispose();
  }
});

test('(e) no workspace declaration: discovery is a NO-OP (no over-discovery of nested configs)', async () => {
  // Without a pnpm-workspace.yaml / package.json workspaces, source 2 contributes nothing — a nested
  // tsconfig stays undiscovered exactly as before (the conservative default the fixture-slurp risk
  // demands). This is the shape of codemaster's own repo.
  const p: TestProject = await project({
    'package.json': '{"name":"root","private":true}',
    'tsconfig.json': `{"compilerOptions":${C},"include":["src"]}`,
    'src/lib.ts': 'export const thing = 1;\n',
    'nested/pkg/tsconfig.json': `{"compilerOptions":${C},"include":["src"]}`,
    'nested/pkg/package.json': '{"name":"nested"}',
    'nested/pkg/src/n.ts': 'export const n = 1;\n',
  });
  try {
    const ue = unusedData(await p.op('find_unused_exports', {}));
    assert.ok(
      (ue.undiscoveredPrograms ?? []).includes('nested/pkg/tsconfig.json'),
      'with no workspace decl, the nested config is NOT auto-discovered',
    );
  } finally {
    await p.dispose();
  }
});
