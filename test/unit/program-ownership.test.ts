// The write gate's program selection and overlay roles (program-ownership.ts, t-401540) over stub
// programs whose glob / built-program membership is given outright, plus `parseConfigFile`'s
// config shape over real files, with TS's own `getParsedCommandLineOfConfigFile` as the oracle for
// the extends chain.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import ts from 'typescript';
import type { RepoRelPath } from '../../src/core/brands.ts';
import type { SingleProgram } from '../../src/plugins/ts/program/single.ts';
import {
  NO_CONFIG_SHAPE,
  parseConfigFile,
  type ConfigShape,
} from '../../src/plugins/ts/program/config-shape.ts';
import {
  affected,
  claimOf,
  extendsOnlyBases,
  type OwnershipCtx,
} from '../../src/plugins/ts/program-ownership.ts';

const ROOT = '/r';
const abs = (rel: string): string => `${ROOT}/${rel}`;
const rel = (s: string): RepoRelPath => s as RepoRelPath;

interface StubSpec {
  config?: string;
  shape?: Partial<ConfigShape>;
  globs?: readonly string[]; // prefixes the glob owns (exists or not)
  contains?: readonly string[]; // files in the built program (tracked or imported)
}

function stub(label: string, spec: StubSpec): SingleProgram {
  const globbed = (a: string): boolean => (spec.globs ?? []).some((g) => a.startsWith(abs(g)));
  const contains = new Set((spec.contains ?? []).map(abs));
  return {
    label,
    configPath: spec.config !== undefined ? abs(spec.config) : undefined,
    configShape: () => ({ ...NO_CONFIG_SHAPE, ...spec.shape }),
    isTracked: (a: string) => contains.has(a) && globbed(a),
    mayContain: globbed,
    containsFile: (a: string) => contains.has(a),
  } as unknown as SingleProgram;
}

function ctxOf(primary: SingleProgram, ...rest: SingleProgram[]): OwnershipCtx {
  return { primary, programs: [primary, ...rest], absOf: (r) => abs(r) };
}

const BASE_SHAPE: Partial<ConfigShape> = { defaultFileSet: true };
const primary = stub('tsconfig.json', { config: 'tsconfig.json', globs: ['scripts/'] });
const extender = (target: string): SingleProgram =>
  stub('packages/app/tsconfig.json', {
    config: 'packages/app/tsconfig.json',
    shape: { extends: [abs(target)] },
    globs: ['packages/app/src/'],
    contains: ['packages/app/src/a.ts'],
  });

test('an extended default-glob base is left out of the gate; each leg alone keeps a config in', () => {
  const base = (shape: Partial<ConfigShape>, config = 'tsconfig.base.json'): SingleProgram =>
    stub(config, { config, shape: { ...BASE_SHAPE, ...shape }, globs: [''] });
  const anchor = [rel('packages/app/src/a.ts')];
  const labels = (ctx: OwnershipCtx): string[] => affected(ctx, anchor).map((p) => p.label);

  const pure = base({});
  assert.deepEqual(extendsOnlyBases(ctxOf(primary, pure, extender('tsconfig.base.json'))), [pure]);
  assert.deepEqual(labels(ctxOf(primary, pure, extender('tsconfig.base.json'))), [
    'tsconfig.json',
    'packages/app/tsconfig.json',
  ]);

  const kept: [string, OwnershipCtx][] = [
    [
      'declares include',
      ctxOf(primary, base({ defaultFileSet: false }), extender('tsconfig.base.json')),
    ],
    ['extended by nobody', ctxOf(primary, base({}), extender('other.json'))],
    [
      'run by a package script',
      ctxOf(primary, base({ runByScript: true }), extender('tsconfig.base.json')),
    ],
    [
      'a references target',
      ctxOf(
        primary,
        base({}),
        extender('tsconfig.base.json'),
        stub('tsconfig.build.json', {
          config: 'tsconfig.build.json',
          shape: { references: [abs('tsconfig.base.json')] },
        }),
      ),
    ],
    [
      'named tsconfig.json (what tsc in its dir picks)',
      ctxOf(
        primary,
        base({}, 'packages/lib/tsconfig.json'),
        extender('packages/lib/tsconfig.json'),
      ),
    ],
  ];
  for (const [leg, ctx] of kept) {
    assert.deepEqual(extendsOnlyBases(ctx), [], leg);
    assert.ok(
      labels(ctx).length === 3,
      `${leg}: the config stays in the gate — ${labels(ctx).join(',')}`,
    );
  }

  const basePrimary = base({});
  assert.deepEqual(
    extendsOnlyBases(ctxOf(basePrimary, extender('tsconfig.base.json'))),
    [],
    'the primary is never left out (t-041300)',
  );
});

test('claimOf: glob owner roots, a transitive holder of the path or its move source is reached', () => {
  const owner = stub('packages/core/tsconfig.json', {
    config: 'packages/core/tsconfig.json',
    globs: ['packages/core/src/'],
    contains: ['packages/core/src/index.ts', 'packages/core/src/greet.ts'],
  });
  const consumer = stub('packages/app/tsconfig.json', {
    config: 'packages/app/tsconfig.json',
    globs: ['packages/app/src/'],
    contains: ['packages/app/src/a.ts', 'packages/core/src/index.ts', 'packages/core/src/greet.ts'],
  });
  const ctx = ctxOf(primary, owner, consumer);
  const programs = ctx.programs;
  const moves = [
    {
      from: rel('packages/core/src/greet.ts'),
      to: rel('packages/core/src/lib/greet.ts'),
      kind: 'file' as const,
    },
  ];
  const dest = abs('packages/core/src/lib/greet.ts');
  const index = abs('packages/core/src/index.ts');

  assert.equal(claimOf(ctx, owner, programs, dest, moves), 'root');
  assert.equal(claimOf(ctx, consumer, programs, index, moves), 'reached');
  assert.equal(
    claimOf(ctx, consumer, programs, dest, moves),
    'reached',
    'the dest follows its source',
  );
  assert.equal(claimOf(ctx, consumer, programs, dest), undefined, 'no pair → no claim');
  assert.equal(
    claimOf(ctx, primary, programs, dest, moves),
    undefined,
    'neither globs the dest nor holds the source',
  );
});

test('claimOf: a folder move hands each dest only to the programs holding its own source', () => {
  const owner = stub('lib', {
    config: 'lib/tsconfig.json',
    globs: ['lib/'],
    contains: ['lib/a.ts', 'lib/b.ts'],
  });
  const partial = stub('app', {
    config: 'app/tsconfig.json',
    globs: ['app/'],
    contains: ['app/x.ts', 'lib/a.ts'],
  });
  const ctx = ctxOf(primary, owner, partial);
  const moves = [{ from: rel('lib'), to: rel('lib2'), kind: 'dir' as const }];
  assert.equal(claimOf(ctx, partial, ctx.programs, abs('lib2/a.ts'), moves), 'reached');
  assert.equal(claimOf(ctx, partial, ctx.programs, abs('lib2/b.ts'), moves), undefined);
  assert.equal(claimOf(ctx, owner, ctx.programs, abs('lib2/b.ts'), moves), 'reached');
  assert.equal(
    claimOf(ctx, primary, ctx.programs, abs('lib2/b.ts'), moves),
    'root',
    'an unglobbed dest is still rooted by the primary',
  );
});

test('parseConfigFile: the extends chain is the one TS resolves; include anywhere in it is not a default set', () => {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'cm-config-shape-')));
  const write = (r: string, body: unknown): string => {
    const p = path.join(dir, r);
    mkdirSync(path.dirname(p), { recursive: true });
    writeFileSync(p, typeof body === 'string' ? body : JSON.stringify(body));
    return p;
  };
  write('strict.json', { compilerOptions: { strict: true } });
  write('globbed.json', { include: ['src'] });
  const base = write('tsconfig.base.json', { extends: ['./strict.json'] });
  const inherits = write('tsconfig.lib.json', {
    extends: ['./tsconfig.base.json', './globbed.json'],
  });
  write('package.json', { scripts: { typecheck: 'tsc -p tsconfig.lib.json' } });

  const oracle = (p: string): string[] => {
    const parsed = ts.getParsedCommandLineOfConfigFile(
      p,
      {},
      {
        ...ts.sys,
        onUnRecoverableConfigFileDiagnostic: () => undefined,
      },
    );
    const configFile = parsed?.options.configFile as ts.TsConfigSourceFile | undefined;
    return (configFile?.extendedSourceFiles ?? []).map((f) => f.split(path.sep).join('/'));
  };

  const b = parseConfigFile(base, dir).shape;
  assert.deepEqual([...b.extends].sort(), oracle(base).sort());
  assert.equal(b.defaultFileSet, true);
  assert.equal(b.runByScript, false);

  const l = parseConfigFile(inherits, dir).shape;
  assert.deepEqual([...l.extends].sort(), oracle(inherits).sort());
  assert.equal(l.extends.length, 3, 'array extends and the nested chain');
  assert.equal(l.defaultFileSet, false, 'include inherited from an extended config');
  assert.equal(l.runByScript, true);

  // A nested config run from the workspace root's scripts, its own package.json script-less.
  const nested = write('packages/lib/tsconfig.build.json', { compilerOptions: {} });
  write('packages/lib/package.json', { name: 'lib' });
  assert.equal(parseConfigFile(nested, dir).shape.runByScript, false);
  write('package.json', { scripts: { build: 'tsc -p packages/lib/tsconfig.build.json' } });
  assert.equal(parseConfigFile(nested, dir).shape.runByScript, true, 'root manifest names it');
  assert.equal(
    parseConfigFile(nested, path.join(dir, 'packages/lib')).shape.runByScript,
    false,
    'manifests above the workspace root are not read',
  );
});
