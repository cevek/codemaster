// Emulated workspace links (t-403708). On a tree without `node_modules` a workspace specifier
// (`@w/core`) resolves to nothing, so a consumer program never contains the declaration file and
// the cross-program reference fan-out drops it silently. The LS host emulates the link a package
// manager would make for a DECLARED dependency; what stays unresolved is floored by name.
//
// Oracle: the same fixture with REAL directory symlinks where pnpm would put them (the layout
// `ls-host-symlink.test.ts` pins the LS against) — the emulated answer must equal it, and the real
// layout must carry no emulation disclosure.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, symlinkSync } from 'node:fs';
import * as path from 'node:path';
import { project, type TestProject } from '../helpers/project.ts';
import type { OpResult } from '../../src/ops/contracts.ts';
import type { JsonValue } from '../../src/core/json.ts';

const C = '"strict":true,"module":"esnext","moduleResolution":"bundler","skipLibCheck":true';

interface Shape {
  /** `app`'s dependency spec on `@w/core` (absent = undeclared). */
  appSpec?: string;
  /** Use npm `workspaces` instead of `pnpm-workspace.yaml`. */
  npm?: boolean;
  preserveSymlinks?: boolean;
  /** Add the package whose entry points at an unbuilt `dist`. */
  withDist?: boolean;
}

function files(shape: Shape): Record<string, string> {
  const appDeps: Record<string, string> = {};
  if (shape.appSpec !== undefined) appDeps['@w/core'] = shape.appSpec;
  if (shape.withDist === true) appDeps['@w/built'] = 'workspace:*';
  const out: Record<string, string> = {
    '.gitignore': 'node_modules\n',
    'package.json': JSON.stringify({
      name: 'root',
      private: true,
      ...(shape.npm === true ? { workspaces: ['packages/*'] } : {}),
    }),
    // The primary owns core's source, so a rename of `greet` is a primary-target mutation.
    'tsconfig.json': `{"compilerOptions":{${C}},"include":["packages/core/src"]}`,
    'packages/core/package.json': JSON.stringify({
      name: '@w/core',
      version: '1.0.0',
      exports: { '.': './src/index.ts' },
    }),
    'packages/core/tsconfig.json': `{"compilerOptions":{${C}},"include":["src"]}`,
    'packages/core/src/index.ts': "export { greet } from './greet';\n",
    'packages/core/src/greet.ts': 'export function greet(n: string): string {\n  return n;\n}\n',
    'packages/app/package.json': JSON.stringify({ name: '@w/app', dependencies: appDeps }),
    'packages/app/tsconfig.json': `{"compilerOptions":{${C}${shape.preserveSymlinks === true ? ',"preserveSymlinks":true' : ''}},"include":["src"]}`,
    'packages/app/src/main.ts':
      "import { greet } from '@w/core';\nexport const hello = greet('x');\n" +
      (shape.withDist === true
        ? "import { shout } from '@w/built';\nexport const s = shout;\n"
        : ''),
  };
  if (shape.npm !== true) out['pnpm-workspace.yaml'] = "packages:\n  - 'packages/*'\n";
  if (shape.withDist === true) {
    out['packages/built/package.json'] = JSON.stringify({
      name: '@w/built',
      types: './dist/index.d.ts',
    });
    out['packages/built/tsconfig.json'] = `{"compilerOptions":{${C}},"include":["src"]}`;
    out['packages/built/src/index.ts'] = 'export const shout = 1;\n';
  }
  return out;
}

/** Real pnpm-style links for app's declared deps — the independent oracle layout. */
function linkReal(p: TestProject, names: readonly string[]): void {
  for (const name of names) {
    const link = path.join(p.root, 'packages/app/node_modules', name);
    mkdirSync(path.dirname(link), { recursive: true });
    symlinkSync(path.join(p.root, 'packages', name.split('/')[1] ?? name), link, 'dir');
  }
}

function okResult(r: OpResult): { data: Record<string, JsonValue>; unsafe: string[] } {
  assert.ok('result' in r && r.result.ok, `expected ok, got ${JSON.stringify(r)}`);
  return {
    data: r.result.data as Record<string, JsonValue>,
    unsafe: (r.result.disclosures ?? []).map((d) => d.unsafe),
  };
}

const usageFiles = (data: Record<string, JsonValue>): string[] =>
  ((data.usages ?? []) as { span: { file: string; line: number } }[])
    .map((u) => `${u.span.file}:${u.span.line}`)
    .sort();

const GREET = { name: 'greet', file: 'packages/core/src/greet.ts', collapseImports: false };
const EMULATED = 'resolution-matches-the-trees-own-tsc';

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

/** Write path: an emulated tree must plan exactly the edits a real install plans — the specifier
 *  stays `@w/core`, no edit lands on a synthetic `node_modules` path, and a dry-run writes nothing. */
async function planOn(
  real: boolean,
  shape: Record<string, string>,
  op: string,
  args: Record<string, JsonValue>,
): Promise<{ data: Record<string, JsonValue>; unsafe: string[] }> {
  const p = await project(shape);
  try {
    if (real) linkReal(p, ['@w/core']);
    const before = p.git('status', '--porcelain');
    const r = okResult(await p.op(op, args));
    assert.equal(p.git('status', '--porcelain'), before, 'a dry-run writes nothing');
    return r;
  } finally {
    await p.dispose();
  }
}

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
