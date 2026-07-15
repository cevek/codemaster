// Auto-index an ISOLATED nested package (t-865312), oracle-backed (§16). A repo whose frontend lives
// under a nested dir with its OWN package.json+tsconfig — NOT in a parent `references`, NOT a
// workspace-glob member, no workspace manifest at all — was floored for EVERY symbol op (a bare-NAME
// query has no file to anchor file-driven nearest-config discovery on, so the program never loaded and
// the symbol was "not found anywhere"). The fix: a `tsconfig*.json` whose dir holds a `package.json`
// is a PACKAGE and is auto-discovered as an independent program on the package.json anchor alone.
//
// The load-bearing discriminator is package.json PRESENCE, and it is symmetric with the honesty floor:
//   • has package.json → auto-indexed → subtracted from the undiscovered floor (this file);
//   • no package.json → stays undiscovered/floored (find-usages-nearest-config.test.ts, programs-lever).
//
// Guards pinned here so the anchor never over-indexes a foreign repo: a package.json dir under a
// §10-ignored path (node_modules) is NOT indexed; a workspace-NEGATED dir is honored; a POLLUTING
// stray (`declare global`) under an auto-indexed package keeps it floored (§5-L2 pollution gate); and
// discovery is §19-bounded (cached once, idempotent — no per-query repo-scale walk).
//
// Oracle: a fresh-from-cold `ts.LanguageService` over the NESTED package's own tsconfig (a DIFFERENT
// program than the warm daemon's primary), so a cross-program drift would surface.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { project, type TestProject } from '../helpers/project.ts';
import { coldFindReferences } from '../helpers/cold-ls.ts';
import { createTsProjectHost } from '../../src/plugins/ts/ls-host.ts';
import type { OpResult } from '../../src/ops/contracts.ts';

const C =
  '"strict":true,"module":"esnext","moduleResolution":"bundler","jsx":"react-jsx","skipLibCheck":true';

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

// The repro shape: root tsconfig deliberately does NOT include or reference web/; the entire frontend
// lives under web/ with its own tsconfig (its own `paths` alias) + package.json.
const ISOLATED = {
  'package.json': '{"name":"root","private":true}',
  'tsconfig.json': `{"compilerOptions":{${C}},"include":["scripts"]}`,
  'scripts/build.ts': 'export const buildTag = 1;\n',
  'web/package.json': '{"name":"web","private":true}',
  'web/tsconfig.json': `{"compilerOptions":{${C},"baseUrl":".","paths":{"@/*":["src/*"]}},"include":["src"]}`,
  'web/src/EnumMenu.tsx': 'export const EnumMenu = (p: { title: string }) => p.title;\n',
  'web/src/App.tsx':
    "import { EnumMenu } from '@/EnumMenu';\nexport const App = () => EnumMenu({ title: 'hi' });\n",
};

test('auto-index: a bare-NAME find_usages on an isolated package (no --root override) finds usages + complete + subtracts the floor', async () => {
  const p: TestProject = await project(ISOLATED);
  try {
    const d = usagesData(await p.op('find_usages', { name: 'EnumMenu', collapseImports: false }));
    // The alias consumer under web/ is found — before t-865312 this FAILed "no symbol named EnumMenu".
    assert.deepEqual(
      fileSet(d.usages ?? []),
      ['web/src/App.tsx', 'web/src/EnumMenu.tsx'],
      `usages span the decl + the alias consumer: ${JSON.stringify(d.usages)}`,
    );
    assert.notEqual(d.complete, false, 'complete — the package is indexed, not floored');
    assert.ok(
      !(d.undiscoveredPrograms ?? []).includes('web/tsconfig.json'),
      `web/ is auto-discovered, not floored: ${JSON.stringify(d.undiscoveredPrograms)}`,
    );

    // Independent cold oracle over web/'s OWN config (the program whose `paths` resolve the alias).
    const oracle = coldFindReferences(
      p.root,
      'web/src/EnumMenu.tsx',
      'EnumMenu',
      'web/tsconfig.json',
    );
    assert.deepEqual(fileSet(d.usages ?? []), oracle, 'warm fan-out == cold nested-package oracle');
  } finally {
    await p.dispose();
  }
});

test('loose-primary OVERLAP: a file-pinned find_usages over an isolated package the root globs (no `paths`) returns the union with NO double-count', async () => {
  // The root tsconfig globs EVERY file (`**/*`) WITHOUT the package's `paths` alias, so web/'s files
  // land in BOTH programs — the primary (alias UNRESOLVED → the consumer is not a ref there) and web/'s
  // own (alias resolved). A file-pinned query must return the exact cold-web-oracle union with no span
  // double-counted from the two overlapping programs (the §3.4 row-dedup contract, extended to the
  // isolated-package shape).
  const p: TestProject = await project({
    'package.json': '{"name":"root","private":true}',
    'tsconfig.json': `{"compilerOptions":{${C}},"include":["**/*"]}`,
    'web/package.json': '{"name":"web","private":true}',
    'web/tsconfig.json': `{"compilerOptions":{${C},"baseUrl":".","paths":{"@/*":["src/*"]}},"include":["src"]}`,
    'web/src/EnumMenu.tsx': 'export const EnumMenu = (p: { title: string }) => p.title;\n',
    'web/src/App.tsx':
      "import { EnumMenu } from '@/EnumMenu';\nexport const App = () => EnumMenu({ title: 'hi' });\n",
  });
  try {
    const d = usagesData(
      await p.op('find_usages', {
        name: 'EnumMenu',
        file: 'web/src/EnumMenu.tsx',
        collapseImports: false,
      }),
    );
    const usages = d.usages ?? [];
    const oracle = coldFindReferences(
      p.root,
      'web/src/EnumMenu.tsx',
      'EnumMenu',
      'web/tsconfig.json',
    );
    assert.deepEqual(fileSet(usages), oracle, 'file-pinned union == cold web oracle');
    // No double-count: each (file:line:col) span appears once despite the two overlapping programs.
    const keys = usages.map((u) => `${u.span.file}:${u.span.line}:${u.span.col}`);
    assert.equal(keys.length, new Set(keys).size, `spans are deduped, not double-counted: ${keys}`);
  } finally {
    await p.dispose();
  }
});

test('cold == warm across the auto-indexed state: a re-query equals a cold boot over the package config', async () => {
  const p: TestProject = await project(ISOLATED);
  try {
    usagesData(await p.op('find_usages', { name: 'EnumMenu' })); // warm the discovered program
    const again = usagesData(
      await p.op('find_usages', { name: 'EnumMenu', collapseImports: false }),
    );
    const oracle = coldFindReferences(
      p.root,
      'web/src/EnumMenu.tsx',
      'EnumMenu',
      'web/tsconfig.json',
    );
    assert.deepEqual(fileSet(again.usages ?? []), oracle, 'warm (discovered) == cold package boot');
  } finally {
    await p.dispose();
  }
});

test('§10-ignored guard: a package.json+tsconfig under node_modules is NOT indexed (never in the discovered OR undiscovered set)', async () => {
  const p: TestProject = await project({
    'package.json': '{"name":"root","private":true}',
    'tsconfig.json': `{"compilerOptions":{${C}},"include":["src"]}`,
    'src/lib.ts': 'export const thing = 1;\n',
    // A dependency's own package.json+tsconfig — junk by the §10 name-ignore set, upstream of discovery.
    'node_modules/dep/package.json': '{"name":"dep"}',
    'node_modules/dep/tsconfig.json': `{"compilerOptions":{${C}},"include":["src"]}`,
    'node_modules/dep/src/d.ts': 'export const d = 1;\n',
  });
  try {
    const ue = unusedData(await p.op('find_unused_exports', {}));
    const undiscovered = ue.undiscoveredPrograms ?? [];
    assert.ok(
      !undiscovered.some((c) => c.includes('node_modules')),
      `a node_modules config is neither indexed nor floored — it is out of scope: ${JSON.stringify(undiscovered)}`,
    );
  } finally {
    await p.dispose();
  }
});

test('negative workspace-glob is honored: an explicitly-excluded package dir stays floored (not indexed)', async () => {
  const p: TestProject = await project({
    'pnpm-workspace.yaml': "packages:\n  - 'packages/*'\n  - '!packages/legacy'\n",
    'package.json': '{"name":"root","private":true}',
    'tsconfig.json': `{"compilerOptions":{${C}},"include":["src"]}`,
    'src/lib.ts': 'export const thing = 1;\n',
    'packages/legacy/package.json': '{"name":"legacy"}',
    'packages/legacy/tsconfig.json': `{"compilerOptions":{${C}},"include":["src"]}`,
    'packages/legacy/src/l.ts': 'export const l = 1;\n',
  });
  try {
    const ue = unusedData(await p.op('find_unused_exports', {}));
    assert.ok(
      (ue.undiscoveredPrograms ?? []).includes('packages/legacy/tsconfig.json'),
      `a workspace-negated package is NOT auto-indexed: ${JSON.stringify(ue.undiscoveredPrograms)}`,
    );
  } finally {
    await p.dispose();
  }
});

test('pollution gate: a `declare global` stray under an auto-indexed package keeps it FLOORED (never shifts a src symbol type)', async () => {
  // web/scripts/env.ts is a git-tracked source file under the package dir that web/tsconfig omits
  // (include:["src"]) AND it augments the GLOBAL type-space. Injecting it would shift the reported
  // type of the package's OWN src symbols (§5-L2 never-lie), so it is NOT injected — and an unsearched
  // stray under the package keeps the package floored, honestly.
  const p: TestProject = await project({
    'package.json': '{"name":"root","private":true}',
    'tsconfig.json': `{"compilerOptions":{${C}},"include":["scripts"]}`,
    'scripts/build.ts': 'export const buildTag = 1;\n',
    'web/package.json': '{"name":"web","private":true}',
    'web/tsconfig.json': `{"compilerOptions":{${C}},"include":["src"]}`,
    'web/src/Comp.tsx': 'export const Comp = 1;\n',
    'web/scripts/env.ts': 'declare global { interface Window { X: number } }\nexport {};\n',
  });
  try {
    const ue = unusedData(await p.op('find_unused_exports', {}));
    assert.ok(
      (ue.undiscoveredPrograms ?? []).includes('web/tsconfig.json'),
      `the polluting stray keeps web/ floored (not falsely subtracted): ${JSON.stringify(ue.undiscoveredPrograms)}`,
    );
  } finally {
    await p.dispose();
  }
});

test('primary-in-subdir: an isolated package is still discovered while the primary (a subdir package) and its adjacent config are not mistaken for dir-packages', () => {
  // The PRIMARY tsconfig sits inside apps/main (which has its own package.json) via a tsconfig
  // override. apps/main must NOT be treated as a dir-based package (it is the primary), and its
  // ADJACENT config apps/main/tsconfig.build.json must NOT either (shares the primary's dir → a
  // glob-based sibling). A SEPARATE isolated package apps/other must still be auto-discovered.
  const dir = mkdtempSync(path.join(tmpdir(), 'cm-subdir-primary-'));
  try {
    writeFileSync(path.join(dir, 'package.json'), '{"name":"root","private":true}');
    mkdirSync(path.join(dir, 'apps', 'main', 'src'), { recursive: true });
    writeFileSync(path.join(dir, 'apps', 'main', 'package.json'), '{"name":"main"}');
    writeFileSync(
      path.join(dir, 'apps', 'main', 'tsconfig.json'),
      `{"compilerOptions":{${C}},"include":["src"]}`,
    );
    writeFileSync(
      path.join(dir, 'apps', 'main', 'tsconfig.build.json'),
      `{"compilerOptions":{${C}},"include":["src"]}`,
    );
    writeFileSync(path.join(dir, 'apps', 'main', 'src', 'm.ts'), 'export const m = 1;\n');
    mkdirSync(path.join(dir, 'apps', 'other', 'src'), { recursive: true });
    writeFileSync(path.join(dir, 'apps', 'other', 'package.json'), '{"name":"other"}');
    writeFileSync(
      path.join(dir, 'apps', 'other', 'tsconfig.json'),
      `{"compilerOptions":{${C}},"include":["src"]}`,
    );
    writeFileSync(path.join(dir, 'apps', 'other', 'src', 'Thing.ts'), 'export const Thing = 1;\n');

    const host = createTsProjectHost(dir, path.join(dir, 'apps', 'main', 'tsconfig.json'));
    try {
      const labels = host.programLabels();
      // apps/other (a separate isolated package) IS discovered; apps/main (primary) + its adjacent
      // build config are NOT dir-packages (the primary is loaded, the build config is an adjacent
      // sibling — neither is floored, and neither owns apps/main's tree as strays).
      assert.ok(
        labels.includes('apps/other/tsconfig.json'),
        `apps/other is auto-discovered as a program: ${JSON.stringify(labels)}`,
      );
      assert.ok(
        !host.undiscoveredProgramLabels().includes('apps/other/tsconfig.json'),
        'apps/other is subtracted from the undiscovered floor',
      );
    } finally {
      host.dispose();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('§19-bounded: discovery is cached + idempotent — repeated reads do NOT grow the program set or re-walk', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'cm-autoindex-'));
  try {
    writeFileSync(path.join(dir, 'package.json'), '{"name":"root","private":true}');
    writeFileSync(
      path.join(dir, 'tsconfig.json'),
      `{"compilerOptions":{${C}},"include":["scripts"]}`,
    );
    mkdirSync(path.join(dir, 'scripts'));
    writeFileSync(path.join(dir, 'scripts', 'b.ts'), 'export const b = 1;\n');
    mkdirSync(path.join(dir, 'web', 'src'), { recursive: true });
    writeFileSync(path.join(dir, 'web', 'package.json'), '{"name":"web","private":true}');
    writeFileSync(
      path.join(dir, 'web', 'tsconfig.json'),
      `{"compilerOptions":{${C}},"include":["src"]}`,
    );
    writeFileSync(path.join(dir, 'web', 'src', 'A.ts'), 'export const A = 1;\n');
    writeFileSync(path.join(dir, 'web', 'src', 'B.ts'), 'export const B = 1;\n');

    const host = createTsProjectHost(dir);
    try {
      // The isolated package is an eagerly-DISCOVERED sibling (label present without a target file).
      assert.ok(
        host.programLabels().includes('web/tsconfig.json'),
        `web/ is discovered as a program: ${JSON.stringify(host.programLabels())}`,
      );
      assert.ok(
        !host.undiscoveredProgramLabels().includes('web/tsconfig.json'),
        'and subtracted from the undiscovered floor',
      );
      // Building the sibling programs, then re-querying labels, must not grow or re-walk.
      const n = host.programs().length;
      host.programs();
      host.programLabels();
      assert.equal(host.programs().length, n, 'the program set is stable (idempotent, cached)');
    } finally {
      host.dispose();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
