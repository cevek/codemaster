// Emulated workspace links (t-403708) on the write path and the reverse-import index: an emulated
// tree must plan the edits and list the importers a real install does — specifiers stay `@w/core`,
// no edit lands on a synthetic `node_modules` path, a dry-run writes nothing.
//
// Oracle: the same fixture with REAL pnpm-style directory symlinks (`helpers/workspace-links-fixture`).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { project } from '../helpers/project.ts';
import { EMULATED, files, linkReal, okResult, planOn } from '../helpers/workspace-links-fixture.ts';

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
