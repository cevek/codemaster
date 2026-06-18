// `:local(.foo)` is the EXPLICIT form of CSS-modules' default scoping — postcss-modules
// compiles `:local(.foo)` to `.foo`, so it must behave EXACTLY like a bare `.foo {}` rule on
// every module-local surface. Two surfaces regressed on it (backlog scss item):
//   - find_unused_scss_classes: `:local(.foo){}` was extracted but NOT recognised as a
//     cleanly-owned rule → demoted to `partial`, unlike the `.foo{}` baseline.
//   - css_cascade: `:local(.foo){}` contributed NO subject for target `foo` → invisible.
// `:global(.x)` is the OPPOSITE (explicit global) and must stay out of the module-local set —
// the symmetry guard below pins that it is never reported as a module class.
//
// Oracle = the fixture's own structure (hand-known), asserted through the REAL ops. The
// strongest case is baseline-equivalence: `.foo{}` and `:local(.bar){}` in one sheet, both
// unused, must yield the IDENTICAL verdict.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { project } from '../helpers/project.ts';
import type { OpResult } from '../../src/ops/contracts.ts';

type Unused = { name: string; confidence: string; note?: string };
type UnusedView = { unused: Unused[]; dynamicModules?: string[] };

type Winner = { confidence: string };
type Property = { prop: string; winner: Winner };
type CascadeData = { target: string; confidence: string; properties: Property[] };

// `.foo{}` and `:local(.bar){}` are BOTH unused (only `.keep` is accessed) — a static-only
// module, so an unaccessed class is provably dead. The two must get the same verdict.
const FIND_UNUSED = {
  'tsconfig.json': '{"compilerOptions":{"strict":true}}',
  'src/s.module.scss':
    '.keep { color: black; }\n.foo { color: red; }\n:local(.bar) { color: blue; }\n',
  'src/use.ts': "import s from './s.module.scss';\nexport const x = s.keep;\n",
};

test('find_unused: `:local(.bar){}` is certain-unused, exactly like the `.foo{}` baseline', async () => {
  const p = await project(FIND_UNUSED);
  try {
    const r = await p.op('find_unused_scss_classes', {});
    assert.ok('result' in r && r.result.ok);
    const view = r.result.data as UnusedView;
    const foo = view.unused.find((c) => c.name === 'foo');
    const bar = view.unused.find((c) => c.name === 'bar');
    assert.equal(foo?.confidence, 'certain', 'plain `.foo{}` baseline is certain-unused');
    assert.equal(bar?.confidence, 'certain', '`:local(.bar){}` must match the baseline');
    assert.equal(bar?.note, foo?.note, 'identical verdict — same note (none)');
  } finally {
    await p.dispose();
  }
});

const FIND_USED = {
  'tsconfig.json': '{"compilerOptions":{"strict":true}}',
  'src/s.module.scss': '.dead { color: black; }\n:local(.foo) { color: red; }\n',
  'src/use.ts': "import s from './s.module.scss';\nexport const x = s.foo;\n",
};

test('find_unused: a TS access to a `:local(.foo)` class marks it USED, never reported dead', async () => {
  const p = await project(FIND_USED);
  try {
    const r = await p.op('find_unused_scss_classes', {});
    assert.ok('result' in r && r.result.ok);
    const view = r.result.data as UnusedView;
    assert.ok(
      !view.unused.some((c) => c.name === 'foo'),
      '`s.foo` is a real use of the `:local(.foo)` class',
    );
    assert.ok(
      view.unused.some((c) => c.name === 'dead'),
      'control: `.dead` is unused',
    );
  } finally {
    await p.dispose();
  }
});

const GLOBAL_GUARD = {
  'tsconfig.json': '{"compilerOptions":{"strict":true}}',
  'src/s.module.scss': '.keep { color: black; }\n:global(.gx) { color: red; }\n',
  'src/use.ts': "import s from './s.module.scss';\nexport const x = s.keep;\n",
};

test('symmetry: `:global(.gx)` is NOT a module-local class — never listed as unused', async () => {
  const p = await project(GLOBAL_GUARD);
  try {
    const r = await p.op('find_unused_scss_classes', {});
    assert.ok('result' in r && r.result.ok);
    const view = r.result.data as UnusedView;
    assert.ok(
      !view.unused.some((c) => c.name === 'gx'),
      '`:global(.gx)` breaks out of module scope — it is not a module class',
    );
  } finally {
    await p.dispose();
  }
});

// css_cascade: `:local(.foo){}` must produce the same resolved cascade as `.bar{}`.
const CASCADE = {
  'tsconfig.json': '{"compilerOptions":{"strict":true}}',
  'src/a.module.scss': ':local(.foo) {\n  color: red;\n}\n.bar {\n  color: red;\n}\n',
};

async function cascade(
  p: Awaited<ReturnType<typeof project>>,
  args: object,
): Promise<{ ok: boolean; data?: CascadeData }> {
  const r: OpResult = await p.op('css_cascade', args as never);
  if ('result' in r && r.result.ok) return { ok: true, data: r.result.data as CascadeData };
  return { ok: false };
}

test('css_cascade: `:local(.foo){}` resolves a certain winner, identical to the `.bar{}` baseline', async () => {
  const p = await project(CASCADE);
  try {
    const foo = await cascade(p, { file: 'src/a.module.scss', class: 'foo' });
    const bar = await cascade(p, { file: 'src/a.module.scss', class: 'bar' });
    assert.ok(foo.ok && foo.data, 'foo resolves');
    assert.ok(bar.ok && bar.data, 'bar resolves (baseline)');
    const fc = foo.data.properties.find((p2) => p2.prop === 'color');
    const bc = bar.data.properties.find((p2) => p2.prop === 'color');
    assert.equal(
      fc?.winner.confidence,
      'certain',
      '`:local(.foo)` is a same-module unconditional winner',
    );
    assert.equal(fc?.winner.confidence, bc?.winner.confidence, 'matches the `.bar{}` baseline');
    assert.equal(foo.data.confidence, bar.data.confidence, 'overall confidence matches baseline');
  } finally {
    await p.dispose();
  }
});

test('css_cascade selector-mode: `:local(.foo)` resolves its subject target', async () => {
  const p = await project(CASCADE);
  try {
    const r = await cascade(p, { selector: ':local(.foo)' });
    assert.ok(r.ok && r.data, 'selector-mode resolves the `:local(...)` subject');
    assert.equal(r.data.target, 'foo', 'subject of `:local(.foo)` is `foo`');
  } finally {
    await p.dispose();
  }
});

// The unwrap must NOT over-own: a `:local(...)` whose arg carries a dependency or a nested
// `:global` is still not a clean module-local class — pinning these guards against a false
// `certain` (the §3.3 over-claim the trust contract forbids).
const NOT_OWNED = {
  'tsconfig.json': '{"compilerOptions":{"strict":true}}',
  'src/s.module.scss':
    '.keep { color: black; }\n' +
    ':local(.dep:not(.other)) { color: red; }\n' + // depends on `.other` → not cleanly owned
    ':local(:global(.gx)) { color: blue; }\n', // arg is :global → `gx` stays global
  'src/use.ts': "import s from './s.module.scss';\nexport const x = s.keep;\n",
};

test('find_unused: `:local(.dep:not(.other))` is NOT cleanly owned → partial, never a false certain', async () => {
  const p = await project(NOT_OWNED);
  try {
    const r = await p.op('find_unused_scss_classes', {});
    assert.ok('result' in r && r.result.ok);
    const view = r.result.data as UnusedView;
    const dep = view.unused.find((c) => c.name === 'dep');
    // `dep` is unused, but its rule depends on `.other` (which stays behind) — deleting it is not
    // provably safe, so it must be `partial`, exactly as a bare `.dep:not(.other){}` would be.
    assert.equal(dep?.confidence, 'partial', '`:not(.other)` dependency keeps it from being owned');
  } finally {
    await p.dispose();
  }
});

test('symmetry: nested `:local(:global(.gx))` keeps `gx` GLOBAL — never a module-local class', async () => {
  const p = await project(NOT_OWNED);
  try {
    const r = await p.op('find_unused_scss_classes', {});
    assert.ok('result' in r && r.result.ok);
    const view = r.result.data as UnusedView;
    assert.ok(
      !view.unused.some((c) => c.name === 'gx'),
      'the inner `:global(.gx)` breaks out of module scope even under `:local(...)`',
    );
  } finally {
    await p.dispose();
  }
});

// DOCUMENTS CURRENT BEHAVIOR (backlog: `:local(.a, .b)` paren-comma list under-reports in
// cascade). A multi-subject `:local(...)` unwraps to `.a, .b`, but analyzeBranch reads only the
// last compound's subject (`b`). This assert pins the current under-report so the eventual
// backlog fix flips it KNOWINGLY (not a silent behavior drift). NOT a regression — the
// multi-subject form was invisible before the `:local` fix too.
const COMMA_LIST = {
  'tsconfig.json': '{"compilerOptions":{"strict":true}}',
  'src/a.module.scss': ':local(.a, .b) {\n  color: red;\n}\n',
};

test('css_cascade: `:local(.a, .b)` currently reports only the last subject `b` (documents backlog gap)', async () => {
  const p = await project(COMMA_LIST);
  try {
    const b = await cascade(p, { file: 'src/a.module.scss', class: 'b' });
    const a = await cascade(p, { file: 'src/a.module.scss', class: 'a' });
    assert.ok(b.ok && b.data, 'last subject `b` resolves a contribution');
    assert.ok(
      b.data.properties.some((p2) => p2.prop === 'color'),
      '`b` has the color winner',
    );
    // CURRENT: `a` (the non-last subject) has no contribution → no property winner. When the
    // backlog item is fixed, `a` should resolve like `b` and this assert must be updated.
    assert.ok(
      a.ok && a.data && a.data.properties.length === 0,
      'CURRENT under-report: non-last subject `a` emits no contribution (see backlog)',
    );
  } finally {
    await p.dispose();
  }
});
