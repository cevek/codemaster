// Workspace-member stray INJECTION (t-232769), oracle-backed (§16). A git-tracked TS-source file
// physically under a workspace member's dir that the member's own tsconfig `include` OMITS (the
// near-universal `packages/x/scripts/smoke.ts` under `include:["src"]`) was compiled by NO program →
// the t-851482 coverage-proof floored the member → every cross-package `find_usages` on the repo
// stayed `complete:false`, and the stray's real (often aliased) usages went unsearched. The fix
// injects each member's strays into that member's OWN program (its compilerOptions/paths) so they are
// SEARCHED with correct alias resolution and the member un-floors — WITHOUT counting the wrong-options
// no-config fallback as coverage (which would resurrect the t-816306 paths-lie). These tests pin it:
//   (f) empty-`include` member: the stray is injected → a primary export used only from it is found
//       USED (not certain-dead) and the member un-floors;
//   (g) partial-coverage member (covers src, STRAYS lib/foo.ts): foo.ts is injected + searched, its
//       usage found, the member un-floors — matching a cold Program over the full set;
//   (h) ALIAS stray: `scripts/smoke.ts` alias-importing ANOTHER member resolves via the member's own
//       `paths` (impossible on the no-config fallback) → the usage is found + the member un-floors;
//   (i) ANTI-LIE NEGATIVE: an undiscovered NON-member config globbing a file the FALLBACK covers but
//       whose alias is UNRESOLVED there stays FLOORED — only correct-resolution coverage subtracts;
//   (k) WRONG-OPTIONS ANCESTOR: a loose root globbing a member stray without the member paths is NOT
//       coverage — the stray is still injected into its member (own-glob gate) and its alias resolves;
//   (j) POLLUTION GATE: a stray carrying `declare global`/`declare module` (or a non-module script)
//       is NOT injected (it would shift the member src symbols' reported types) — the member stays
//       floored + the stray unsearched, vs a CLEAN module stray which IS injected + searched.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'node:path';
import ts from 'typescript';
import { project, type TestProject } from '../helpers/project.ts';
import type { OpResult } from '../../src/ops/contracts.ts';

const C = '{"strict":true,"module":"esnext","moduleResolution":"bundler"}';

type Usage = { span: { file: string; line: number; col: number }; role: string };
type UsagesData = { usages?: Usage[]; complete?: boolean; undiscoveredPrograms?: string[] };
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
test("(f) STRAY INJECTION (empty-`include` member): the member's git-tracked stray is injected + searched → the primary export is found USED (not certain-dead) and the member un-floors", async () => {
  // t-232769 (supersedes t-851482 residual #2): a workspace MEMBER whose tsconfig has an EMPTY
  // `include` still physically holds `packages/orphan/src/o.ts` (git-tracked, uses primary `thing`).
  // The OLD behaviour floored the member (o.ts in no program) → `thing` demoted to `partial`. NOW
  // o.ts is a member-owned stray → injected into the orphan program → SEARCHED under the member's own
  // options → `thing`'s usage in o.ts is found. So `thing` is NOT dead, and (o.ts being the only
  // git-tracked TS under the member, now covered) the member un-floors — honest by resolution.
  const p: TestProject = await project({
    'pnpm-workspace.yaml': "packages:\n  - 'packages/*'\n",
    'package.json': '{"name":"root","private":true}',
    'tsconfig.json': `{"compilerOptions":${C},"include":["src"]}`, // does NOT glob packages/*
    'src/lib.ts': 'export const thing = 1;\n', // used only from the orphan member's stray o.ts
    'packages/orphan/package.json': '{"name":"orphan"}',
    'packages/orphan/tsconfig.json': `{"compilerOptions":${C},"include":[]}`,
    'packages/orphan/src/o.ts':
      "import { thing } from '../../../src/lib';\nexport const usesThing = thing + 1;\n",
  });
  try {
    // find_unused_exports: `thing` is now USED (found in the injected o.ts) → it is NOT reported as an
    // unused export at all. The old certain-vs-partial dance is moot — the usage is genuinely searched.
    const ue = unusedData(await p.op('find_unused_exports', {}));
    assert.ok(
      !ue.unused.some((x) => x.name === 'thing'),
      `thing is used from the injected stray → not unused: ${JSON.stringify(ue.unused)}`,
    );

    // find_usages: the stray o.ts usage is FOUND, and the member no longer floors it.
    const d = usagesData(await p.op('find_usages', { name: 'thing', collapseImports: false }));
    assert.ok(
      fileSet(d.usages ?? []).includes('packages/orphan/src/o.ts'),
      `the injected stray usage must be found: ${JSON.stringify(fileSet(d.usages ?? []))}`,
    );
    assert.notEqual(d.complete, false, 'the member un-floors once its stray is searched');
    assert.deepEqual(d.undiscoveredPrograms ?? [], [], 'no floor: the stray is now covered');
  } finally {
    await p.dispose();
  }
});

test("(g) STRAY INJECTION (partial-coverage member): covers src, STRAYS lib/foo.ts → foo.ts is injected + searched under the member's options, its usage is found, the member un-floors", async () => {
  // t-232769 (supersedes t-851482 precise-floor): a MEMBER covers SOME of its files (`include:["src"]`
  // → src/x.ts) but STRAYS `packages/pkg/lib/foo.ts` (globbed by NO config). foo.ts uses primary
  // `thing`. The OLD behaviour floored the member. NOW foo.ts is a member-owned stray → injected into
  // the pkg program → searched under the member's own options → the usage is found and the member un-floors.
  const p: TestProject = await project({
    'pnpm-workspace.yaml': "packages:\n  - 'packages/*'\n",
    'package.json': '{"name":"root","private":true}',
    'tsconfig.json': `{"compilerOptions":${C},"include":["src"]}`, // globs the root src only
    'src/lib.ts': 'export const thing = 1;\n',
    'packages/pkg/package.json': '{"name":"pkg"}',
    'packages/pkg/tsconfig.json': `{"compilerOptions":${C},"include":["src"]}`,
    'packages/pkg/src/x.ts': 'export const y = 1;\n',
    // The STRAY: under the member dir, globbed by no config, and it USES `thing`.
    'packages/pkg/lib/foo.ts':
      "import { thing } from '../../../src/lib';\nexport const usesThing = thing + 1;\n",
  });
  try {
    // Independent oracle: a fresh-from-cold `ts.Program` over the FULL file set (incl. the stray) —
    // the warm daemon (with the stray injected) must MATCH it: lib/foo.ts genuinely uses `thing`.
    const oracle = ts.createProgram(
      ['src/lib.ts', 'packages/pkg/src/x.ts', 'packages/pkg/lib/foo.ts'].map((f) =>
        path.join(p.root, f),
      ),
      {
        strict: true,
        module: ts.ModuleKind.ESNext,
        moduleResolution: ts.ModuleResolutionKind.Bundler,
        noEmit: true,
      },
    );
    const errs = ts
      .getPreEmitDiagnostics(oracle)
      .map((d) => ts.flattenDiagnosticMessageText(d.messageText, '\n'));
    assert.deepEqual(errs, [], `oracle: the stray genuinely uses \`thing\`: ${errs.join(' | ')}`);

    // find_unused_exports: `thing` is USED from the injected stray → not reported unused.
    const ue = unusedData(await p.op('find_unused_exports', {}));
    assert.ok(
      !ue.unused.some((x) => x.name === 'thing'),
      `thing is used from the injected stray → not unused: ${JSON.stringify(ue.unused)}`,
    );

    // find_usages: the stray usage is FOUND (matching the cold oracle) and the member un-floors.
    const d = usagesData(await p.op('find_usages', { name: 'thing', collapseImports: false }));
    assert.ok(
      fileSet(d.usages ?? []).includes('packages/pkg/lib/foo.ts'),
      `the injected stray usage must be found: ${JSON.stringify(fileSet(d.usages ?? []))}`,
    );
    assert.notEqual(d.complete, false, 'the member un-floors once its strayed file is searched');
    assert.deepEqual(d.undiscoveredPrograms ?? [], [], 'no floor: the strayed file is now covered');
  } finally {
    await p.dispose();
  }
});
test('(h) ALIAS stray: a member `scripts/smoke.ts` (outside `include`) alias-importing ANOTHER member is injected into its OWN program → the alias resolves via the member paths and the usage is found', async () => {
  // t-232769 core, faithful to claude-ui: no root tsconfig (fallback primary), member `grok` with
  // `include:["src"]` and a git-tracked `scripts/smoke.ts` that `import { MeshThing } from '@x/bridge'`.
  // The fallback primary has NO `paths` → it can NOT resolve `@x/bridge`. Only grok's OWN config (with
  // its `paths`) resolves it, and smoke.ts is OUTSIDE grok's `include` → the usage is found ONLY once
  // smoke.ts is injected into grok's program. Un-floors + resolves correctly, by construction.
  const paths = '"baseUrl":".","paths":{"@x/bridge":["../bridge/src/index.ts"]}';
  const p: TestProject = await project({
    'pnpm-workspace.yaml': "packages:\n  - 'packages/*'\n",
    'package.json': '{"name":"root","private":true}', // NO root tsconfig → fallback primary
    'packages/bridge/package.json': '{"name":"@x/bridge"}',
    'packages/bridge/tsconfig.json': `{"compilerOptions":${C},"include":["src"]}`,
    'packages/bridge/src/index.ts': 'export class MeshThing { go() { return 1; } }\n',
    'packages/grok/package.json': '{"name":"@x/grok"}',
    'packages/grok/tsconfig.json': `{"compilerOptions":{"strict":true,"module":"esnext","moduleResolution":"bundler",${paths}},"include":["src"]}`,
    // Rename on import (`as MB`) so the by-name `MeshThing` lookup targets the single CLASS decl,
    // not the local import bindings (which the by-name resolver would count as ambiguous aliases).
    'packages/grok/src/index.ts':
      "import { MeshThing as MB } from '@x/bridge';\nexport const g = new MB();\n",
    // The STRAY: outside grok's `include:["src"]`, alias-imports @x/bridge, references MeshThing.
    'packages/grok/scripts/smoke.ts':
      "import { MeshThing as MB } from '@x/bridge';\nconst m = new MB();\nm.go();\n",
  });
  try {
    const d = usagesData(await p.op('find_usages', { name: 'MeshThing', collapseImports: false }));
    const files = fileSet(d.usages ?? []);
    assert.ok(
      files.includes('packages/grok/scripts/smoke.ts'),
      `the injected alias stray usage must be found: ${JSON.stringify(files)}`,
    );
    assert.notEqual(
      d.complete,
      false,
      'both members covered (bridge src, grok src + injected stray)',
    );
    assert.deepEqual(d.undiscoveredPrograms ?? [], [], 'no floor once the stray is injected');

    // Oracle: a cold Program over grok's OWN options (paths) + the injected stray compiles with NO
    // error, proving smoke.ts's `@x/bridge` import genuinely resolves under grok's config.
    const oracle = ts.createProgram(
      [
        'packages/bridge/src/index.ts',
        'packages/grok/src/index.ts',
        'packages/grok/scripts/smoke.ts',
      ].map((f) => path.join(p.root, f)),
      {
        strict: true,
        module: ts.ModuleKind.ESNext,
        moduleResolution: ts.ModuleResolutionKind.Bundler,
        baseUrl: path.join(p.root, 'packages/grok'),
        paths: { '@x/bridge': ['../bridge/src/index.ts'] },
        ignoreDeprecations: '6.0', // silence the TS6 `baseUrl` deprecation NOTE (not a resolution error)
        noEmit: true,
      },
    );
    const errs = ts
      .getPreEmitDiagnostics(oracle)
      .map((e) => ts.flattenDiagnosticMessageText(e.messageText, '\n'));
    assert.deepEqual(
      errs,
      [],
      `oracle: the alias stray resolves under grok's options: ${errs.join(' | ')}`,
    );
  } finally {
    await p.dispose();
  }
});

test('(i) ANTI-LIE NEGATIVE: an undiscovered NON-member config globbing a fallback-covered file whose alias is UNRESOLVED there STAYS floored (only correct-resolution coverage subtracts)', async () => {
  // The discriminating case (fails on a naive covered-union, passes on the correct-resolution one):
  // no root tsconfig → the fallback primary globs `tools/foo.ts`, but the fallback has NO `paths` so
  // `foo.ts`'s `@x/bridge` import is UNRESOLVED there (the usage is genuinely missed). `tools/` is NOT
  // a workspace member (globs are `packages/*`) → foo.ts is never injected, and `tools/tsconfig.json`
  // is undiscovered. Its glob (`foo.ts`) is covered ONLY by the fallback → excluded from the
  // correct-resolution union → the config is NOT subtracted → complete:false. A naive union (seeded
  // with the fallback's whole-repo glob) would wrongly subtract it → complete:true, the resurrected lie.
  const p: TestProject = await project({
    'pnpm-workspace.yaml': "packages:\n  - 'packages/*'\n",
    'package.json': '{"name":"root","private":true}', // NO root tsconfig → fallback primary
    'packages/bridge/package.json': '{"name":"@x/bridge"}',
    'packages/bridge/tsconfig.json': `{"compilerOptions":${C},"include":["src"]}`,
    'packages/bridge/src/index.ts': 'export class MeshThing { go() { return 1; } }\n',
    // NON-member (not under packages/*), undiscovered config with its OWN paths — but never loaded.
    'tools/tsconfig.json': `{"compilerOptions":{"strict":true,"module":"esnext","moduleResolution":"bundler","baseUrl":".","paths":{"@x/bridge":["../packages/bridge/src/index.ts"]}},"include":["."]}`,
    'tools/foo.ts': "import { MeshThing as MB } from '@x/bridge';\nexport const f = new MB();\n",
  });
  try {
    const d = usagesData(await p.op('find_usages', { name: 'MeshThing', collapseImports: false }));
    // The fallback-only tools/foo.ts usage is NOT found (its alias never resolved), so the honest
    // answer is FLOORED, naming the undiscovered non-member config — never a claimed-complete result.
    assert.equal(
      d.complete,
      false,
      'a fallback-only-covered config must stay floored (correct-resolution union)',
    );
    assert.ok(
      (d.undiscoveredPrograms ?? []).includes('tools/tsconfig.json'),
      `the undiscovered non-member config stays named: ${JSON.stringify(d.undiscoveredPrograms)}`,
    );
    assert.ok(
      !fileSet(d.usages ?? []).includes('tools/foo.ts'),
      'the fallback cannot resolve the alias, so tools/foo.ts is honestly NOT claimed as a usage',
    );
  } finally {
    await p.dispose();
  }
});

test("(j) POLLUTION GATE: a stray carrying `declare global` is NOT injected (it would shift the member src symbols' reported types) — the member STAYS floored + the stray is unsearched, vs a CLEAN stray which IS injected", async () => {
  // The manager's required Part-A guard, made discriminating. Injecting a stray is only safe when it
  // cannot alter the member's OWN type-space: TS `declare global`/`declare module '…'` augmentation is
  // program-wide, so injecting it would make `expand_type` of a member src symbol report a type the
  // member's real tsconfig never yields (the never-lie violation §3). So an augmentation stray is NOT
  // injected and its member STAYS floored (honestly unsearched) — while a CLEAN module stray IS
  // injected + searched. The two branches share everything but the stray's content: the discriminator
  // is `declare global`.
  const base = {
    'pnpm-workspace.yaml': "packages:\n  - 'packages/*'\n",
    'package.json': '{"name":"root","private":true}',
    // A REAL root primary that globs the ROOT src ONLY — so it does NOT glob packages/m/scripts, and
    // the ONLY way the stray could enter a program (and pollute) is our injection. (A no-config
    // fallback primary would glob the whole repo incl. the stray, masking the gate.)
    'tsconfig.json': `{"compilerOptions":${C},"include":["src"]}`,
    'src/root.ts': 'export const r = 1;\n',
    'packages/m/package.json': '{"name":"m"}',
    'packages/m/tsconfig.json': `{"compilerOptions":${C},"include":["src"]}`,
    'packages/m/src/index.ts': 'export const base = 1;\n',
  };
  const stray = (aug: boolean): string =>
    `${aug ? 'declare global { const POLLUTANT: number }\n' : ''}import { base } from '../src/index';\nexport const s = base + 1;\n`;
  const augP = await project({ ...base, 'packages/m/scripts/smoke.ts': stray(true) });
  const cleanP = await project({ ...base, 'packages/m/scripts/smoke.ts': stray(false) });
  try {
    // AUGMENTATION stray → NOT injected: its `base` usage is NOT found and the member STAYS floored.
    const aug = usagesData(await augP.op('find_usages', { name: 'base', collapseImports: false }));
    assert.ok(
      !fileSet(aug.usages ?? []).includes('packages/m/scripts/smoke.ts'),
      `the augmentation stray must NOT be searched (not injected): ${JSON.stringify(fileSet(aug.usages ?? []))}`,
    );
    assert.equal(
      aug.complete,
      false,
      'the member stays floored while an un-injectable stray remains',
    );
    assert.ok(
      (aug.undiscoveredPrograms ?? []).includes('packages/m/tsconfig.json'),
      `the member with an augmentation stray is named as floored: ${JSON.stringify(aug.undiscoveredPrograms)}`,
    );

    // CLEAN stray (identical but for the `declare global`) → IS injected + searched + un-floors.
    const clean = usagesData(
      await cleanP.op('find_usages', { name: 'base', collapseImports: false }),
    );
    assert.ok(
      fileSet(clean.usages ?? []).includes('packages/m/scripts/smoke.ts'),
      `the clean stray IS injected + searched: ${JSON.stringify(fileSet(clean.usages ?? []))}`,
    );
    assert.notEqual(clean.complete, false, 'the clean stray un-floors its member');
  } finally {
    await augP.dispose();
    await cleanP.dispose();
  }
});

test('(k) WRONG-OPTIONS ANCESTOR: a LOOSE ROOT that globs a member stray WITHOUT the member paths does NOT count as coverage — the stray is still injected into its member (own-glob gate) and its alias is found', async () => {
  // The own-glob gate (not the whole covered-union): here a real root tsconfig `include:["packages"]`
  // globs `packages/grok/scripts/smoke.ts`, but the root has NO `@x/bridge` paths → it can NOT resolve
  // the stray's alias. If injection were skipped whenever ANY program globs the file, smoke.ts would be
  // searched ONLY under the wrong-options root (alias missed) while grok un-floors — the coverage lie.
  // Gating on the member's OWN glob keeps smoke.ts a stray-for-grok → injected → alias resolved.
  const gp =
    '{"strict":true,"module":"esnext","moduleResolution":"bundler","baseUrl":".","paths":{"@x/bridge":["../bridge/src/index.ts"]}}';
  const p: TestProject = await project({
    'pnpm-workspace.yaml': "packages:\n  - 'packages/*'\n",
    'package.json': '{"name":"root","private":true}',
    'tsconfig.json': `{"compilerOptions":${C},"include":["packages"]}`, // loose root, NO @x/bridge paths
    'packages/bridge/package.json': '{"name":"@x/bridge"}',
    'packages/bridge/tsconfig.json': `{"compilerOptions":${C},"include":["src"]}`,
    'packages/bridge/src/index.ts': 'export class MeshThing { go() { return 1; } }\n',
    'packages/grok/package.json': '{"name":"@x/grok"}',
    'packages/grok/tsconfig.json': `{"compilerOptions":${gp},"include":["src"]}`,
    'packages/grok/src/index.ts':
      "import { MeshThing as MB } from '@x/bridge';\nexport const g = new MB();\n",
    'packages/grok/scripts/smoke.ts':
      "import { MeshThing as MB } from '@x/bridge';\nconst m = new MB();\nm.go();\n",
  });
  try {
    const d = usagesData(await p.op('find_usages', { name: 'MeshThing', collapseImports: false }));
    assert.ok(
      fileSet(d.usages ?? []).includes('packages/grok/scripts/smoke.ts'),
      `the stray is injected into grok (own paths) despite the loose root globbing it: ${JSON.stringify(fileSet(d.usages ?? []))}`,
    );
    assert.notEqual(d.complete, false);
  } finally {
    await p.dispose();
  }
});

test('(l) WARM stray-add: a git-tracked stray added to an un-floored member on a WARM daemon is injected on the next query — the usage is NOT silently missed (cold == warm)', async () => {
  // The cold≠warm gap: coverage is memoized per structural reindex. A member covers its src (un-floored),
  // the daemon warms, THEN a git-tracked stray is added under the member (a plain source add, no tsconfig
  // change). Left stale, the warm daemon would inject nothing → miss the stray's usage AND report
  // complete — a §3.4/§3.5 lie. The reindex refreshes coverage when a NEW TS file lands under a member dir.
  const p: TestProject = await project({
    'pnpm-workspace.yaml': "packages:\n  - 'packages/*'\n",
    'package.json': '{"name":"root","private":true}',
    'tsconfig.json': `{"compilerOptions":${C},"include":["src"]}`,
    'src/root.ts': 'export const r = 1;\n',
    'packages/m/package.json': '{"name":"m"}',
    'packages/m/tsconfig.json': `{"compilerOptions":${C},"include":["src"]}`,
    'packages/m/src/index.ts': 'export const base = 1;\n',
  });
  try {
    // Warm: the member covers its src → un-floored, and the stray does not exist yet.
    const before = usagesData(await p.op('find_usages', { name: 'base', collapseImports: false }));
    assert.ok(
      !fileSet(before.usages ?? []).includes('packages/m/scripts/smoke.ts'),
      'the stray does not exist yet',
    );

    // Add a git-tracked stray under the member (outside its `include`), commit — no tsconfig change.
    p.write(
      'packages/m/scripts/smoke.ts',
      "import { base } from '../src/index';\nexport const s = base + 1;\n",
    );
    p.commit('add member stray on a warm daemon');

    // The warm daemon injects it on the next query — the usage is found, not silently missed.
    const after = usagesData(await p.op('find_usages', { name: 'base', collapseImports: false }));
    assert.ok(
      fileSet(after.usages ?? []).includes('packages/m/scripts/smoke.ts'),
      `the warm-added stray must be injected + searched: ${JSON.stringify(fileSet(after.usages ?? []))}`,
    );
  } finally {
    await p.dispose();
  }
});
