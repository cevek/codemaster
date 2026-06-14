// Stage 3 oracle (spec-scss-css-honesty §3): `scanCssModuleUsages` must be SCOPE-AWARE. A
// lambda/catch binding that shadows the css-module import name (`useStore((s) => s.field)`)
// is NOT the css import, so its `s.X` accesses must not pollute the usage scan (which would
// read a shadowed field as "class used" and hide a genuinely-dead class). Oracle = an
// independent hand-built expectation over a VFS fixture, checked end-to-end through
// find_unused_scss_classes (the consumer of cssModuleUsages).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { project } from '../helpers/project.ts';

type Unused = { name: string; confidence: string };
type View = { unused: Unused[] };

// `.real` is reached via the genuine css import; `.field`/`.foo` only ever appear under a
// lambda parameter `s` that shadows the import — so they are NOT used and stay reported unused.
const FIXTURE = {
  'tsconfig.json': '{"compilerOptions":{"strict":true}}',
  'src/s.module.scss': '.real { color: red; }\n.field { color: blue; }\n.foo { color: green; }\n',
  'src/use.ts':
    "import s from './s.module.scss';\n" +
    'declare function useStore<T>(sel: (s: { field: number }) => T): T;\n' +
    'export const a = s.real;\n' + // genuine css access → `real` used
    'export const b = useStore((s) => s.field);\n' + // shadowed `s.field` → NOT a css access
    'export const c = [1].map((s) => s.foo);\n', // shadowed `s.foo` → NOT a css access
};

test('a shadowed `s.X` access is not counted as a css-module class usage', async () => {
  const p = await project(FIXTURE);
  try {
    const r = await p.op('find_unused_scss_classes', {});
    assert.ok('result' in r && r.result.ok);
    const unused = new Set((r.result.data as View).unused.map((u) => u.name));
    // The genuine `s.real` access counts → `real` is NOT unused.
    assert.ok(!unused.has('real'), '`s.real` (real css import) must read as used');
    // The shadowed `s.field` / `s.foo` accesses are the lambda params, not the import →
    // those classes are still unused (a naive whole-file scan would falsely hide them).
    assert.ok(unused.has('field'), 'shadowed `s.field` must NOT count `field` as used');
    assert.ok(unused.has('foo'), 'shadowed `s.foo` must NOT count `foo` as used');
  } finally {
    await p.dispose();
  }
});
