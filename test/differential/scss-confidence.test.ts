// §3.3 confidence honesty on the scss cross-tier path: a class reached only through a
// COMPUTED access (`styles[expr]`) cannot be proven dead, so `find_unused_scss_classes`
// must DEMOTE that module's unused-claims — never report a maybe-used class as definitely
// dead (the exact over-claim §3.3 forbids). The independent oracle is the fixture's own
// structure: `.a` is reached statically, `.b` only exists, and a `styles[k]` access makes
// the whole module's deadness unprovable.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { project } from '../helpers/project.ts';

type Unused = { name: string; confidence: string; note?: string };
type View = { unused: Unused[]; dynamicModules?: string[] };

const STATIC = {
  'tsconfig.json': '{"compilerOptions":{"strict":true}}',
  'src/s.module.scss': '.a { color: red; }\n.b { color: blue; }\n',
  'src/use.ts': "import s from './s.module.scss';\nexport const x = s.a;\n",
};

const COMPUTED = {
  ...STATIC,
  // A computed access `s[k]` is added — now no class in this module is provably dead.
  'src/use.ts':
    "import s from './s.module.scss';\n" +
    'export const x = s.a;\n' +
    'declare const k: string;\n' +
    'export const y = s[k];\n',
};

test('static access only: `.b` is provably unused with certain confidence', async () => {
  const p = await project(STATIC);
  try {
    const r = await p.op('find_unused_scss_classes', {});
    assert.ok('result' in r && r.result.ok);
    const view = r.result.data as View;
    const b = view.unused.find((c) => c.name === 'b');
    assert.equal(b?.confidence, 'certain', 'no dynamic access → deadness is type-proven');
    assert.equal(view.dynamicModules, undefined, 'no module flagged dynamic');
  } finally {
    await p.dispose();
  }
});

// An interpolated selector in a css-MODULE sheet: the class name is computed, never guessed, so
// it can't be proven dead → partial. (Kept here because the kitchensink S9 pin lives in a flat
// `base.scss`, where the global-stylesheet demotion now takes precedence over the interpolation
// reason — this keeps the interpolation→partial invariant covered in a module context.)
const INTERPOLATED = {
  'tsconfig.json': '{"compilerOptions":{"strict":true}}',
  'src/s.module.scss': '.a { color: red; }\n$n: 3;\n.icon-#{$n} { width: 16px; }\n',
  'src/use.ts': "import s from './s.module.scss';\nexport const x = s.a;\n",
};

test('interpolated-selector class in a MODULE sheet is partial, never certain dead', async () => {
  const p = await project(INTERPOLATED);
  try {
    const r = await p.op('find_unused_scss_classes', {});
    assert.ok('result' in r && r.result.ok);
    const view = r.result.data as View;
    const icon = view.unused.find((c) => c.name === 'icon-');
    assert.ok(icon !== undefined, 'the interpolated class is reported (not silently dropped)');
    assert.equal(icon.confidence, 'partial', 'a computed class name is never certain dead');
    assert.ok(icon.note !== undefined, 'the demotion reason is stated, not silent');
  } finally {
    await p.dispose();
  }
});

test('computed `s[expr]` access demotes the module: unused class is partial, never falsely dead', async () => {
  const p = await project(COMPUTED);
  try {
    const r = await p.op('find_unused_scss_classes', {});
    assert.ok('result' in r && r.result.ok);
    const view = r.result.data as View;
    const b = view.unused.find((c) => c.name === 'b');
    // `.b` is textually unused, but the computed access means we CANNOT prove it dead.
    assert.equal(
      b?.confidence,
      'partial',
      'computed access demotes the claim — never a false "dead"',
    );
    assert.match(b?.note ?? '', /computed access/, 'the demotion reason is stated, not silent');
    assert.deepEqual(
      view.dynamicModules,
      ['src/s.module.scss'],
      'the module with computed access is named, so the uncertainty is legible',
    );
  } finally {
    await p.dispose();
  }
});
