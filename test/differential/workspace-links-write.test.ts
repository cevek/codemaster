// Emulated workspace links (t-403708) on the write path and the reverse-import index: an emulated
// tree must plan the edits and list the importers a real install does — specifiers stay `@w/core`,
// no edit lands on a synthetic `node_modules` path, a dry-run writes nothing.
//
// Oracle: the same fixture with REAL pnpm-style directory symlinks (`helpers/workspace-links-fixture`).

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
  planOn,
  usageFiles,
} from '../helpers/workspace-links-fixture.ts';

test('rename_symbol across the emulated link rewrites the consumer exactly as on a real install', async () => {
  const shape = {
    ...files({ appSpec: 'workspace:*' }),
    'packages/core/src/index.ts': 'export function greet(n: string): string {\n  return n;\n}\n',
  };
  const args = { name: 'greet', file: 'packages/core/src/index.ts', newName: 'hail' };
  const emu = await planOn(false, shape, 'rename_symbol', args);
  const real = await planOn(true, shape, 'rename_symbol', args);
  assert.deepEqual(emu.data.touched, real.data.touched);
  assert.equal(emu.data.diff, real.data.diff);
  assert.ok(
    (emu.data.touched as string[]).includes('packages/app/src/main.ts'),
    JSON.stringify(emu.data),
  );
  assert.match(String(emu.data.diff), /import \{ hail \} from '@w\/core'/);
  assert.doesNotMatch(String(emu.data.diff), /node_modules/);
  assert.ok(emu.unsafe.includes(EMULATED));
});

test('move_file inside a workspace package keeps `@w/core` specifiers — same plan as a real install', async () => {
  const shape = files({ appSpec: 'workspace:*' });
  const args = { from: 'packages/core/src/greet.ts', to: 'packages/core/src/lib/greet.ts' };
  const emu = await planOn(false, shape, 'move_file', args);
  const real = await planOn(true, shape, 'move_file', args);
  assert.deepEqual(emu.data.touched, real.data.touched);
  assert.equal(emu.data.diff, real.data.diff);
  // The gate's verdict is the install's too (its own false dangle on this shape is t-037355).
  assert.deepEqual(emu.data.typecheck, real.data.typecheck);
  const touched = emu.data.touched as string[];
  assert.ok(!touched.includes('packages/app/src/main.ts'), 'the consumer import is not rewritten');
  assert.ok(
    touched.every((f) => !f.includes('node_modules')),
    JSON.stringify(touched),
  );
});

test('importers_of a workspace package specifier answers as on a real install', async () => {
  const emu = await project(files({ appSpec: 'workspace:*' }));
  const real = await project(files({ appSpec: 'workspace:*' }));
  try {
    linkReal(real, ['@w/core']);
    const e = okResult(await emu.op('importers_of', { module: '@w/core' }));
    const r = okResult(await real.op('importers_of', { module: '@w/core' }));
    assert.deepEqual(e.data, r.data);
    assert.ok(
      JSON.stringify(e.data).includes('packages/app/src/main.ts:1'),
      JSON.stringify(e.data),
    );
  } finally {
    await emu.dispose();
    await real.dispose();
  }
});

test('the reverse-import index (importers_of by file, affected) sees the consumer through the link', async () => {
  const shape = {
    ...files({ appSpec: 'workspace:*' }),
    'packages/app/src/main.test.ts': "import { hello } from './main';\nexport const t = hello;\n",
  };
  const emu = await project(shape);
  const real = await project(shape);
  try {
    linkReal(real, ['@w/core']);
    for (const [op, args] of [
      ['importers_of', { module: 'packages/core/src/index.ts' }],
      ['affected', { files: ['packages/core/src/greet.ts'] }],
    ] as const) {
      const e = okResult(await emu.op(op, args));
      const r = okResult(await real.op(op, args));
      assert.deepEqual(e.data, r.data, op);
      const text = JSON.stringify(e.data);
      const want =
        op === 'affected' ? 'packages/app/src/main.test.ts' : 'packages/app/src/main.ts:1';
      assert.ok(text.includes(want), `${op}: ${text}`);
    }
  } finally {
    await emu.dispose();
    await real.dispose();
  }
});

test("conflicting specs across dependency fields do not link (the manager's precedence is not guessed)", async () => {
  const p = await project({
    ...files({ npm: true }),
    'packages/app/package.json': JSON.stringify({
      name: '@w/app',
      dependencies: { '@w/core': '2.0.0' },
      peerDependencies: { '@w/core': '*' },
    }),
  });
  try {
    const { data } = okResult(await p.op('find_usages', GREET));
    assert.ok(!usageFiles(data).includes('packages/app/src/main.ts:2'), JSON.stringify(data));
    assert.deepEqual(
      (data.unresolvedWorkspaceImports as { package: string }[]).map((l) => l.package),
      ['@w/core'],
    );
  } finally {
    await p.dispose();
  }
});

test('pnpm: the root package is a workspace member a child can depend on', async () => {
  const base = files({ appSpec: 'workspace:*' });
  const p = await project({
    ...base,
    'package.json': JSON.stringify({ name: '@w/root', exports: { '.': './rootlib.ts' } }),
    'rootlib.ts': 'export const rootThing = 1;\n',
    'tsconfig.json': `{"compilerOptions":{${C}},"include":["packages/core/src","rootlib.ts"]}`,
    'packages/app/package.json': JSON.stringify({
      name: '@w/app',
      dependencies: { '@w/core': 'workspace:*', '@w/root': 'workspace:*' },
    }),
    'packages/app/src/main.ts':
      "import { greet } from '@w/core';\nimport { rootThing } from '@w/root';\nexport const hello = greet('x') + String(rootThing);\n",
  });
  try {
    const { data } = okResult(
      await p.op('find_usages', { name: 'rootThing', file: 'rootlib.ts', collapseImports: false }),
    );
    assert.ok(usageFiles(data).includes('packages/app/src/main.ts:3'), JSON.stringify(data));
  } finally {
    await p.dispose();
  }
});

test('floor: a static `import x = require(...)` of an unlinked workspace package is a floored site', async () => {
  const p = await project({
    ...files({}),
    'packages/app/src/main.ts': "import core = require('@w/core');\nexport const hello = core;\n",
  });
  try {
    const { data } = okResult(await p.op('find_usages', GREET));
    const lost = data.unresolvedWorkspaceImports as { package: string; examples: string[] }[];
    assert.deepEqual(
      lost.map((l) => [l.package, l.examples]),
      [['@w/core', ['packages/app/src/main.ts:1']]],
    );
  } finally {
    await p.dispose();
  }
});

test('a tsconfig extending a config package through a link globs the same files as a real install', async () => {
  const shape = {
    ...files({ appSpec: 'workspace:*' }),
    'packages/app/package.json': JSON.stringify({
      name: '@w/app',
      dependencies: { '@w/core': 'workspace:*' },
      devDependencies: { '@w/config': 'workspace:*' },
    }),
    'packages/config/package.json': JSON.stringify({ name: '@w/config' }),
    'packages/config/app.json': `{"compilerOptions":{${C}},"include":["../app/src"]}`,
    'packages/app/tsconfig.json': '{"extends":"@w/config/app.json"}',
  };
  const emu = await project(shape);
  const real = await project(shape);
  try {
    linkReal(real, ['@w/core', '@w/config']);
    const e = okResult(await emu.op('find_usages', GREET));
    const r = okResult(await real.op('find_usages', GREET));
    assert.ok(usageFiles(r.data).includes('packages/app/src/main.ts:2'), JSON.stringify(r.data));
    assert.deepEqual(usageFiles(e.data), usageFiles(r.data));
  } finally {
    await emu.dispose();
    await real.dispose();
  }
});
