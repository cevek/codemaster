// `find_phantom_deps` (t-272300) — per package, a bare import whose package name is NOT in that
// package's own package.json yet RESOLVES via node_modules hoisting ("works locally, breaks on a
// clean install"). The honesty stakes are FALSE POSITIVES: every legit import that is NOT a phantom
// must be excluded, or the op is noise. So the negatives ARE the proof — a test that only asserts the
// true phantom passes even if the op flags everything.
//
// Oracle (§16): the expected phantom set is hand-derived INDEPENDENTLY from the fixture's package.json
// declarations + import list — not from the op. `project()` writes real files (incl. a real
// node_modules), so specifiers resolve for real through the project's own module resolution.
//
// The fixture is a pnpm-style monorepo: the ROOT declares `@mui/material` (hoisted to root
// node_modules), but the `apps/emr` package does NOT declare it — the exact motivating incident.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { project, type TestProject } from '../helpers/project.ts';
import type { OpResult } from '../../src/ops/contracts.ts';

const C = '"strict":true,"module":"esnext","moduleResolution":"bundler","skipLibCheck":true';

type PhantomRow = {
  importer: string;
  specifier: string;
  resolvedFrom: string;
  importSiteCount: number;
};
function phantoms(r: OpResult): PhantomRow[] {
  assert.ok('result' in r && r.result.ok, JSON.stringify(r));
  return (r.result.data as { phantoms?: PhantomRow[] }).phantoms ?? [];
}

// A monorepo where `apps/emr` uses several packages; only `@mui/material` is a phantom (undeclared in
// apps/emr, provided only by the hoisted root install). Every other import is a legit NON-phantom.
const MONOREPO = {
  'package.json':
    '{"name":"root","private":true,"workspaces":["apps/*"],"dependencies":{"@mui/material":"^5.0.0"}}',
  'tsconfig.json': `{"compilerOptions":{${C}},"include":["apps"]}`,
  // hoisted root deps
  'node_modules/@mui/material/package.json': '{"name":"@mui/material","version":"5.0.0"}',
  'node_modules/@mui/material/index.d.ts': 'export const Button: number;\n',
  'node_modules/lodash/package.json': '{"name":"lodash","version":"4.0.0"}',
  'node_modules/lodash/index.d.ts': 'export const map: number;\n',
  // apps/emr's OWN local install
  'apps/emr/node_modules/localdep/package.json': '{"name":"localdep","version":"1.0.0"}',
  'apps/emr/node_modules/localdep/index.d.ts': 'export const x: number;\n',
  // apps/emr declares lodash + localdep, but NOT @mui/material
  'apps/emr/package.json':
    '{"name":"@app/emr","dependencies":{"lodash":"^4.0.0","localdep":"^1.0.0"}}',
  'apps/emr/tsconfig.json': `{"compilerOptions":{${C},"baseUrl":".","paths":{"@/*":["src/*"]}},"include":["src"]}`,
  'apps/emr/src/a.ts':
    "import { Button } from '@mui/material';\n" + // PHANTOM (undeclared, hoisted)
    "import { map } from 'lodash';\n" + // declared → not phantom
    "import { x } from 'localdep';\n" + // declared + local install → not phantom
    "import { helper } from '@/helper';\n" + // path alias → workspace source → not phantom
    "import { readFileSync } from 'node:fs';\n" + // builtin → not phantom
    "import { emr } from '@app/emr';\n" + // self-name → not phantom
    'export const use = [Button, map, x, helper, readFileSync, emr];\n',
  'apps/emr/src/b.ts': "import { Button } from '@mui/material';\nexport const b = Button;\n", // 2nd phantom SITE
  'apps/emr/src/helper.ts': 'export const helper = 1;\n',
  'apps/emr/src/index.ts': 'export const emr = 1;\n',
};

test('find_phantom_deps: flags ONLY the undeclared hoisted dep — declared / local / path-alias / builtin / self-name are all excluded', async () => {
  const p: TestProject = await project(MONOREPO);
  try {
    const rows = phantoms(await p.op('find_phantom_deps', {}));

    // Hand-derived oracle: exactly ONE phantom group — apps/emr → @mui/material.
    assert.equal(rows.length, 1, `exactly one phantom group: ${JSON.stringify(rows)}`);
    const row = rows[0];
    assert.equal(row?.importer, 'apps/emr');
    assert.equal(row?.specifier, '@mui/material');
    assert.equal(row?.importSiteCount, 2, 'both a.ts + b.ts sites counted');
    assert.match(
      row?.resolvedFrom ?? '',
      /node_modules\/@mui\/material/,
      'hoist origin is the root node_modules',
    );

    // The NEGATIVES — the real proof there are no false positives.
    const flagged = new Set(rows.map((x) => x.specifier));
    for (const legit of ['lodash', 'localdep', '@/helper', 'node:fs', 'fs', '@app/emr']) {
      assert.ok(!flagged.has(legit), `${legit} must NOT be flagged as phantom`);
    }
  } finally {
    await p.dispose();
  }
});

test('find_phantom_deps: a type-only import satisfied by a declared @types/<pkg> is NOT phantom; a VALUE import of a @types-only package IS', async () => {
  // `import type` of `parseit`, satisfied by the declared `@types/parseit` (a types-only dep needs no
  // runtime package) → NOT phantom. A VALUE import of `runtimeonly` where only `@types/runtimeonly`
  // is declared → STILL phantom (types don't provide runtime).
  const p: TestProject = await project({
    'package.json':
      '{"name":"root","private":true,"devDependencies":{"@types/parseit":"^1.0.0","@types/runtimeonly":"^1.0.0"}}',
    'tsconfig.json': `{"compilerOptions":{${C}},"include":["src"]}`,
    'node_modules/parseit/package.json': '{"name":"parseit"}',
    'node_modules/parseit/index.d.ts': 'export type T = number;\nexport const v: number;\n',
    'node_modules/runtimeonly/package.json': '{"name":"runtimeonly"}',
    'node_modules/runtimeonly/index.d.ts': 'export const r: number;\n',
    'src/x.ts':
      "import type { T } from 'parseit';\n" +
      "import { r } from 'runtimeonly';\n" +
      'export const use: T = r;\n',
  });
  try {
    const flagged = new Set(phantoms(await p.op('find_phantom_deps', {})).map((x) => x.specifier));
    assert.ok(
      !flagged.has('parseit'),
      'type-only import satisfied by declared @types/parseit → not phantom',
    );
    assert.ok(
      flagged.has('runtimeonly'),
      'value import with only @types/runtimeonly declared → phantom',
    );
  } finally {
    await p.dispose();
  }
});

test('find_phantom_deps: a SCOPED type-only import satisfied by its DefinitelyTyped `@types/scope__name` is NOT phantom (the mangled name)', async () => {
  // The DT convention mangles a scoped name: `@scope/thing` → `@types/scope__thing`. A naive
  // `@types/@scope/thing` check never matches, flagging a correctly-declared scoped types-only dep as
  // phantom — the exact false positive this asserts against. (Unscoped packages pass either way, so
  // only a SCOPED fixture discriminates.)
  const p: TestProject = await project({
    'package.json':
      '{"name":"root","private":true,"devDependencies":{"@types/scope__thing":"^1.0.0"}}',
    'tsconfig.json': `{"compilerOptions":{${C}},"include":["src"]}`,
    'node_modules/@scope/thing/package.json': '{"name":"@scope/thing"}',
    'node_modules/@scope/thing/index.d.ts': 'export type T = number;\n',
    'src/x.ts': "import type { T } from '@scope/thing';\nexport const use: T = 1;\n",
  });
  try {
    const flagged = new Set(phantoms(await p.op('find_phantom_deps', {})).map((x) => x.specifier));
    assert.ok(
      !flagged.has('@scope/thing'),
      'scoped type-only import satisfied by @types/scope__thing → not phantom',
    );
  } finally {
    await p.dispose();
  }
});

test('find_phantom_deps: a clean package (every bare import declared) reports zero phantoms', async () => {
  const p: TestProject = await project({
    'package.json': '{"name":"root","private":true,"dependencies":{"lodash":"^4.0.0"}}',
    'tsconfig.json': `{"compilerOptions":{${C}},"include":["src"]}`,
    'node_modules/lodash/package.json': '{"name":"lodash"}',
    'node_modules/lodash/index.d.ts': 'export const map: number;\n',
    'src/x.ts': "import { map } from 'lodash';\nexport const y = map;\n",
  });
  try {
    assert.deepEqual(
      phantoms(await p.op('find_phantom_deps', {})),
      [],
      'no phantoms — lodash is declared',
    );
  } finally {
    await p.dispose();
  }
});
