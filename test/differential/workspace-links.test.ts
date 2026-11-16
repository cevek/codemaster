// Emulated workspace links (t-403708). On a tree without `node_modules` a workspace specifier
// (`@w/core`) resolves to nothing, so a consumer program never contains the declaration file and
// the cross-program reference fan-out drops it silently. The LS host emulates the link a package
// manager would make for a DECLARED dependency; what stays unresolved is floored by name.
//
// Oracle: the same fixture with REAL directory symlinks where pnpm would put them
// (`helpers/workspace-links-fixture`; the layout `ls-host-symlink.test.ts` pins the LS against) — the emulated answer must equal it, and the real
// layout must carry no emulation disclosure.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { project } from '../helpers/project.ts';
import {
  C,
  EMULATED,
  GREET,
  files,
  linkReal,
  okResult,
  usageFiles,
} from '../helpers/workspace-links-fixture.ts';

test('a declared workspace:* dependency resolves through an emulated link — same usages as a real install', async () => {
  const emu = await project(files({ appSpec: 'workspace:*', withDist: true }));
  const real = await project(files({ appSpec: 'workspace:*', withDist: true }));
  try {
    linkReal(real, ['@w/core', '@w/built']);
    const e = okResult(await emu.op('find_usages', GREET));
    const r = okResult(await real.op('find_usages', GREET));
    assert.ok(usageFiles(e.data).includes('packages/app/src/main.ts:2'), JSON.stringify(e.data));
    assert.deepEqual(usageFiles(e.data), usageFiles(r.data));
    assert.ok(e.unsafe.includes(EMULATED), 'the emulated answer says so');
    assert.ok(!r.unsafe.includes(EMULATED), 'a real install carries no emulation claim');
    // An entry into an unbuilt `dist` resolves on neither tree: floored by name, never a silent 0.
    for (const { data } of [e, r]) {
      assert.equal(data.complete, false);
      const lost = data.unresolvedWorkspaceImports as { package: string; examples: string[] }[];
      assert.deepEqual(
        lost.map((l) => [l.package, l.examples]),
        [['@w/built', ['packages/app/src/main.ts:3']]],
      );
    }
  } finally {
    await emu.dispose();
    await real.dispose();
  }
});

test('a real install with every import resolved: no floor, no disclosure', async () => {
  const real = await project(files({ appSpec: 'workspace:*' }));
  try {
    linkReal(real, ['@w/core']);
    const r = okResult(await real.op('find_usages', GREET));
    assert.ok(usageFiles(r.data).includes('packages/app/src/main.ts:2'));
    assert.equal(r.data.unresolvedWorkspaceImports, undefined);
    assert.ok(!r.unsafe.includes(EMULATED));
  } finally {
    await real.dispose();
  }
});

for (const [label, shape] of [
  ['an undeclared import', {}],
  ['a pnpm non-workspace: range', { appSpec: '^1.0.0' }],
  ['an npm range the member version does not equal', { appSpec: '^1.0.0', npm: true }],
  ['a preserveSymlinks program', { appSpec: 'workspace:*', preserveSymlinks: true }],
  ['a workspace: alias naming another member', { appSpec: 'workspace:@w/app@*' }],
  [
    'a workspace: range the member version does not trivially satisfy',
    { appSpec: 'workspace:^2.0.0' },
  ],
] as const) {
  test(`${label} is not linked: the usage is floored by specifier, not silently missing`, async () => {
    const p = await project(files(shape));
    try {
      const { data, unsafe } = okResult(await p.op('find_usages', GREET));
      assert.ok(!usageFiles(data).includes('packages/app/src/main.ts:2'), JSON.stringify(data));
      assert.equal(data.complete, false);
      const lost = data.unresolvedWorkspaceImports as { package: string }[];
      assert.deepEqual(
        lost.map((l) => l.package),
        ['@w/core'],
      );
      assert.ok(!unsafe.includes(EMULATED));
      const notes = (data.notes ?? []) as string[];
      assert.ok(notes.some((n) => n.includes('@w/core') && n.startsWith('!! LOWER BOUND')));
    } finally {
      await p.dispose();
    }
  });
}

test('npm workspaces: the exact member version links', async () => {
  const p = await project(files({ appSpec: '1.0.0', npm: true }));
  try {
    const { data } = okResult(await p.op('find_usages', GREET));
    assert.ok(usageFiles(data).includes('packages/app/src/main.ts:2'), JSON.stringify(data));
  } finally {
    await p.dispose();
  }
});

test('member_usages crosses the emulated link like find_usages', async () => {
  const p = await project({
    ...files({ appSpec: 'workspace:*' }),
    'packages/core/src/greet.ts':
      'export function greet(n: string): string {\n  return n;\n}\nexport type Box = { v: number };\n',
    'packages/core/src/index.ts': "export { greet, type Box } from './greet';\n",
    'packages/app/src/main.ts':
      "import { greet, type Box } from '@w/core';\nexport const hello = greet('x');\nexport const read = (b: Box): number => b.v;\n",
  });
  try {
    const { data } = okResult(
      await p.op('member_usages', { name: 'Box', file: 'packages/core/src/greet.ts', member: 'v' }),
    );
    const sites = (data.sites as { span: { file: string; line: number } }[]).map(
      (s) => `${s.span.file}:${s.span.line}`,
    );
    assert.deepEqual(sites, ['packages/app/src/main.ts:3']);
  } finally {
    await p.dispose();
  }
});

test('warm: declaring the dependency later re-resolves the unchanged importer (cold == warm)', async () => {
  const p = await project(files({}));
  try {
    const before = okResult(await p.op('find_usages', GREET));
    assert.ok(!usageFiles(before.data).includes('packages/app/src/main.ts:2'));
    p.write(
      'packages/app/package.json',
      JSON.stringify({ name: '@w/app', dependencies: { '@w/core': 'workspace:*' } }),
    );
    p.commit('declare dep');
    const after = okResult(await p.op('find_usages', GREET));
    assert.ok(
      usageFiles(after.data).includes('packages/app/src/main.ts:2'),
      JSON.stringify(after.data),
    );
    assert.equal(after.data.unresolvedWorkspaceImports, undefined);
  } finally {
    await p.dispose();
  }
});

test('a primary tsconfig extending a workspace config package builds (link map ready at parse time)', async () => {
  const base = files({ appSpec: 'workspace:*' });
  const p = await project({
    ...base,
    'package.json': JSON.stringify({
      name: 'root',
      private: true,
      devDependencies: { '@w/config': 'workspace:*' },
    }),
    'packages/config/package.json': JSON.stringify({ name: '@w/config' }),
    'packages/config/base.json': `{"compilerOptions":{${C}}}`,
    'tsconfig.json': '{"extends":"@w/config/base.json","include":["packages/core/src"]}',
  });
  try {
    const { data } = okResult(await p.op('find_usages', GREET));
    assert.ok(usageFiles(data).includes('packages/app/src/main.ts:2'), JSON.stringify(data));
  } finally {
    await p.dispose();
  }
});

test('warm: a member package.json added later joins the link map', async () => {
  const shape = files({ appSpec: 'workspace:*' });
  delete shape['packages/core/package.json'];
  const p = await project(shape);
  try {
    const before = okResult(await p.op('find_usages', GREET));
    assert.ok(!usageFiles(before.data).includes('packages/app/src/main.ts:2'));
    p.write(
      'packages/core/package.json',
      JSON.stringify({ name: '@w/core', version: '1.0.0', exports: { '.': './src/index.ts' } }),
    );
    p.commit('add core manifest');
    const after = okResult(await p.op('find_usages', GREET));
    assert.ok(
      usageFiles(after.data).includes('packages/app/src/main.ts:2'),
      JSON.stringify(after.data),
    );
  } finally {
    await p.dispose();
  }
});

test('floor: two workspace imports on one line are two sites — a resolved one never hides the other', async () => {
  const p = await project({
    ...files({ appSpec: 'workspace:*', withDist: true }),
    'packages/app/src/main.ts':
      "import { greet } from '@w/core'; import { shout } from '@w/built';\nexport const hello = greet('x') + String(shout);\n",
  });
  try {
    const { data } = okResult(await p.op('find_usages', GREET));
    const lost = data.unresolvedWorkspaceImports as { package: string; sites: number }[];
    assert.deepEqual(
      lost.map((l) => [l.package, l.sites]),
      [['@w/built', 1]],
    );
  } finally {
    await p.dispose();
  }
});

test('floor: a site is resolved in its own mode — an ESM import of an `import`-only missing entry is floored', async () => {
  const NODENEXT =
    '"strict":true,"module":"nodenext","moduleResolution":"nodenext","skipLibCheck":true';
  const p = await project({
    ...files({ appSpec: 'workspace:*' }),
    'packages/core/package.json': JSON.stringify({
      name: '@w/core',
      exports: { '.': { import: './dist/missing.js', require: './src/index.ts' } },
    }),
    'packages/app/package.json': JSON.stringify({
      name: '@w/app',
      type: 'module',
      dependencies: { '@w/core': 'workspace:*' },
    }),
    'packages/app/tsconfig.json': `{"compilerOptions":{${NODENEXT}},"include":["src"]}`,
  });
  try {
    const { data } = okResult(await p.op('find_usages', GREET));
    assert.ok(!usageFiles(data).includes('packages/app/src/main.ts:2'), JSON.stringify(data));
    const lost = (data.unresolvedWorkspaceImports ?? []) as { package: string }[];
    assert.deepEqual(
      lost.map((l) => l.package),
      ['@w/core'],
    );
  } finally {
    await p.dispose();
  }
});
