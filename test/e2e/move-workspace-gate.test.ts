// move_file in a pnpm-shaped monorepo (t-401540): a root `tsconfig.base.json` holding only
// compilerOptions, packages that extend it, and a workspace package `@w/core` consumed through a
// real `node_modules` symlink. Three moves the project's own typecheck accepts, each refused by a
// different gate/rewrite defect when that defect is present:
//   - a `.tsx` move — the base config's default `**/*` glob must not judge it (no `jsx` there);
//   - a move inside `core` — `app` holds core's files only through the import, and must get the dest;
//   - a move of an `app` file importing `@w/core` — the bare specifier must survive (a relative
//     path into `packages/core` is a real TS6059 under app's `rootDir: "."`).
// Oracle: a cold `ts.Program` per package config over the applied tree.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, symlinkSync } from 'node:fs';
import * as path from 'node:path';
import { coldDiagnostics } from '../helpers/cold-ls.ts';
import type { JsonValue } from '../../src/core/json.ts';
import { project } from '../helpers/project.ts';

const BASE = JSON.stringify({
  compilerOptions: {
    strict: true,
    module: 'esnext',
    moduleResolution: 'bundler',
    lib: ['ES2022'],
    noEmit: true,
  },
});

const WORKSPACE = {
  '.gitignore': 'node_modules\n',
  'tsconfig.base.json': BASE,
  'tsconfig.json': '{"extends":"./tsconfig.base.json","include":["scripts"]}',
  'scripts/keep.ts': 'export const keep = 1;\n',
  'packages/core/package.json': '{"name":"@w/core","types":"src/index.ts"}',
  'packages/core/tsconfig.json': '{"extends":"../../tsconfig.base.json","include":["src"]}',
  'packages/core/src/index.ts': "export { greet } from './greet';\n",
  'packages/core/src/greet.ts': 'export const greet = (n: string): string => `hi ${n}`;\n',
  'packages/app/package.json': '{"name":"app"}',
  'packages/app/tsconfig.json':
    '{"extends":"../../tsconfig.base.json","compilerOptions":{"rootDir":".","jsx":"preserve"},"include":["src"]}',
  'packages/app/src/jsx.d.ts':
    'declare namespace JSX { interface IntrinsicElements { [tag: string]: unknown } }\n',
  'packages/app/src/Hello.tsx': 'export const Hello = (): unknown => <div />;\n',
  'packages/app/src/main.ts':
    "import { greet } from '@w/core';\nimport { Hello } from './Hello';\nexport const t = [greet('x'), Hello];\n",
};

type Envelope = {
  typecheck: { clean: boolean; introduced?: { file: string; message?: string }[] };
  applied?: boolean;
  notes?: string[];
};
type Proj = Awaited<ReturnType<typeof project>>;

async function mount(): Promise<Proj> {
  const p = await project(WORKSPACE);
  const scope = path.join(p.root, 'packages/app/node_modules/@w');
  mkdirSync(scope, { recursive: true });
  symlinkSync(path.join(p.root, 'packages/core'), path.join(scope, 'core'), 'dir');
  return p;
}

async function move(p: Proj, source: string, dest: string, apply = false): Promise<Envelope> {
  const [r] = await p.request([
    { name: 'move_file', args: { source, dest } as JsonValue, ...(apply ? { apply: true } : {}) },
  ]);
  if (r === undefined || 'error' in r) assert.fail(`dispatch error: ${JSON.stringify(r)}`);
  assert.ok(r.result.ok, `expected ok, got ${JSON.stringify(r)}`);
  return r.result.data as unknown as Envelope;
}

function assertPackagesClean(root: string): void {
  for (const config of ['packages/app/tsconfig.json', 'packages/core/tsconfig.json']) {
    assert.deepEqual(coldDiagnostics(root, config), [], `cold ${config}`);
  }
}

test('ORACLE: the workspace fixture is clean under every package config before any move', async () => {
  const p = await mount();
  try {
    assertPackagesClean(p.root);
  } finally {
    await p.dispose();
  }
});

test('move_file .tsx: the extends-only base config does not judge it; the skip is disclosed', async () => {
  const p = await mount();
  try {
    const src = 'packages/app/src/Hello.tsx';
    const dest = 'packages/app/src/ui/Hello.tsx';
    const dry = await move(p, src, dest);
    assert.equal(dry.typecheck.clean, true, JSON.stringify(dry.typecheck));
    assert.ok(
      (dry.notes ?? []).some((n) =>
        /skipped 1 extends-only base config.*tsconfig\.base\.json/.test(n),
      ),
      `the skipped base is named: ${JSON.stringify(dry.notes)}`,
    );
    assert.equal((await move(p, src, dest, true)).applied, true);
    assertPackagesClean(p.root);
  } finally {
    await p.dispose();
  }
});

test('move_file inside a workspace package: the consumer holding it transitively gets the dest', async () => {
  const p = await mount();
  try {
    const src = 'packages/core/src/greet.ts';
    const dest = 'packages/core/src/lib/greet.ts';
    const dry = await move(p, src, dest);
    assert.equal(dry.typecheck.clean, true, JSON.stringify(dry.typecheck));
    assert.equal((await move(p, src, dest, true)).applied, true);
    assertPackagesClean(p.root);
  } finally {
    await p.dispose();
  }
});

test('move_file of an importer keeps its bare workspace-package specifier', async () => {
  const p = await mount();
  try {
    const src = 'packages/app/src/main.ts';
    const dest = 'packages/app/src/entry/main.ts';
    const dry = await move(p, src, dest);
    assert.equal(dry.typecheck.clean, true, JSON.stringify(dry.typecheck));
    assert.equal((await move(p, src, dest, true)).applied, true);
    const moved = readFileSync(path.join(p.root, dest), 'utf8');
    assert.match(moved, /from '@w\/core'/, moved);
    assert.match(moved, /from '\.\.\/Hello'/, 'the relative import still follows the move');
    assertPackagesClean(p.root);
  } finally {
    await p.dispose();
  }
});
