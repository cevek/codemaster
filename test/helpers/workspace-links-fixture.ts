// The workspace-links fixture (t-403708): a pnpm/npm monorepo whose `app` imports `@w/core`, mounted
// without `node_modules`, plus the oracle layout — REAL directory symlinks where pnpm would put them.

import assert from 'node:assert/strict';
import { mkdirSync, symlinkSync } from 'node:fs';
import * as path from 'node:path';
import { project, type TestProject } from './project.ts';
import type { OpResult } from '../../src/ops/contracts.ts';
import type { JsonValue } from '../../src/core/json.ts';

export const C = '"strict":true,"module":"esnext","moduleResolution":"bundler","skipLibCheck":true';

export interface Shape {
  /** `app`'s dependency spec on `@w/core` (absent = undeclared). */
  appSpec?: string;
  /** Use npm `workspaces` instead of `pnpm-workspace.yaml`. */
  npm?: boolean;
  preserveSymlinks?: boolean;
  /** Add the package whose entry points at an unbuilt `dist`. */
  withDist?: boolean;
}

export function files(shape: Shape): Record<string, string> {
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
export function linkReal(p: TestProject, names: readonly string[]): void {
  for (const name of names) {
    const link = path.join(p.root, 'packages/app/node_modules', name);
    mkdirSync(path.dirname(link), { recursive: true });
    symlinkSync(path.join(p.root, 'packages', name.split('/')[1] ?? name), link, 'dir');
  }
}

export function okResult(r: OpResult): { data: Record<string, JsonValue>; unsafe: string[] } {
  assert.ok('result' in r && r.result.ok, `expected ok, got ${JSON.stringify(r)}`);
  return {
    data: r.result.data as Record<string, JsonValue>,
    unsafe: (r.result.disclosures ?? []).map((d) => d.unsafe),
  };
}

export const usageFiles = (data: Record<string, JsonValue>): string[] =>
  ((data.usages ?? []) as { span: { file: string; line: number } }[])
    .map((u) => `${u.span.file}:${u.span.line}`)
    .sort();

export const GREET = { name: 'greet', file: 'packages/core/src/greet.ts', collapseImports: false };
export const EMULATED = 'resolution-matches-the-trees-own-tsc';

/** Write path: an emulated tree must plan exactly the edits a real install plans — the specifier
 *  stays `@w/core`, no edit lands on a synthetic `node_modules` path, and a dry-run writes nothing. */
export async function planOn(
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
