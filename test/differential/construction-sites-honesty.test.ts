// `construction_sites` — HONESTY / edge-case tests (the trust contract §3 is the product). These
// pin the never-lie behaviours the bug reviewers exercised: a vacuous TOP/OPEN target must never
// flood every literal with false `certain`; a class-member encloser SymbolId must CHAIN; a
// truncated 0-match scan must not assert non-existence; a value target must be labelled `value`.
// Core which-sites/confidence oracle lives in construction-sites.test.ts.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { project } from '../helpers/project.ts';
import { USER_TYPE, type CView } from '../helpers/construction.ts';

const STRICT = '{"compilerOptions":{"strict":true}}';

test('a vacuous TOP/OPEN target never floods every literal with false `certain`', async () => {
  // {}, a marker interface, `any`, `object`, Record<string,unknown> accept EVERY object literal —
  // reporting them all `certain` would be the cardinal lie (bug-reviewer §1).
  const p = await project({
    'tsconfig.json': STRICT,
    'src/types.ts':
      'export interface Marker {}\nexport type Anything = any;\nexport type Loose = Record<string, unknown>;\nexport type Obj = object;\n',
    'src/lits.ts': "export const a = { foo: 1, bar: 2 };\nexport const b = { zzz: 'q' };\n",
  });
  try {
    for (const name of ['Marker', 'Anything', 'Loose', 'Obj']) {
      const r = await p.op('construction_sites', { name });
      assert.ok('result' in r && r.result.ok, JSON.stringify(r));
      const view = r.result.data as CView;
      assert.equal(view.sites.length, 0, `${name} is vacuous — must report 0 sites, not a flood`);
      assert.ok(
        (view.notes ?? []).some((n) => /top\/open type|trivially satisf/.test(n)),
        `${name} must carry the vacuous-target note`,
      );
    }
  } finally {
    await p.dispose();
  }
});

test('the global `Object` (prototype-bearing) is caught as vacuous, not flooded', async () => {
  // `Object` has prototype-method properties, so a naive getProperties() check would miss it —
  // but it accepts EVERY object literal (bug-reviewer 2nd pass).
  const obj = await project({
    'tsconfig.json': STRICT,
    'src/types.ts': 'export type Cap = Object;\n',
    'src/lits.ts': "export const a = { foo: 1 };\nexport const b = { zzz: 'q' };\n",
  });
  try {
    const r = await obj.op('construction_sites', { name: 'Cap' });
    assert.ok('result' in r && r.result.ok, JSON.stringify(r));
    const view = r.result.data as CView;
    assert.equal(view.sites.length, 0, 'global Object is vacuous — must not flood');
    assert.ok(
      (view.notes ?? []).some((n) => /top\/open type/.test(n)),
      'Object carries the note',
    );
  } finally {
    await obj.dispose();
  }
});

test('a CONSTRAINING shape (Record<string,number>) stays a real, non-vacuous query', async () => {
  const p = await project({
    'tsconfig.json': STRICT,
    'src/types.ts': 'export type Strict = Record<string, number>;\n',
    'src/lits.ts': "export const ok = { a: 1, b: 2 };\nexport const bad = { a: 'x' };\n",
  });
  try {
    const r = await p.op('construction_sites', { name: 'Strict' });
    assert.ok('result' in r && r.result.ok, JSON.stringify(r));
    const view = r.result.data as CView;
    // `bad` (string value) is excluded; `ok` (all-number) is a real, non-vacuous match.
    assert.ok(view.sites.length >= 1, 'a constraining index sig is NOT vacuous');
    assert.ok(!view.sites.some((s) => s.encloser.name === 'bad'), 'string-valued literal excluded');
  } finally {
    await p.dispose();
  }
});

test('class-member encloser SymbolId chains (bare token, not the dotted display name)', async () => {
  const p = await project({
    'tsconfig.json': STRICT,
    'src/types.ts': USER_TYPE,
    'src/c.ts': `import type { User } from './types';
export class Factory {
  config: User = { id: 1, name: 'a' };
  make(): User { return { id: 2, name: 'b' }; }
}
`,
  });
  try {
    const r = await p.op('construction_sites', { name: 'User' });
    assert.ok('result' in r && r.result.ok, JSON.stringify(r));
    const view = r.result.data as CView;
    // Display name qualifies with the class; the id must still resolve (anchored on the bare token).
    const method = view.sites.find((s) => s.encloser.name === 'Factory.make');
    assert.ok(method !== undefined, 'class method encloser carries the qualified display name');

    const def = await p.op('find_definition', { symbolId: method.encloser.id });
    assert.ok('result' in def && def.result.ok, JSON.stringify(def));
    const defs = (def.result.data as { definitions?: { name: string }[] }).definitions ?? [];
    assert.ok(
      defs.some((d) => d.name === 'make'),
      'the class-member id chains to its declaration, not `gone`',
    );
  } finally {
    await p.dispose();
  }
});

test('a truncated 0-match scan does NOT assert non-existence (completeness honesty)', async () => {
  // Fill the cap with literals that do NOT match, and place a real match past the cap.
  const noise = Array.from(
    { length: 8 },
    (_, i) => `export const n${i} = { other${i}: ${i} };`,
  ).join('\n');
  const p = await project({
    'tsconfig.json': STRICT,
    'src/types.ts': USER_TYPE,
    'src/a-noise.ts': `${noise}\n`,
    'src/z-real.ts': `import type { User } from './types';\nexport const real: User = { id: 1, name: 'a' };\n`,
  });
  try {
    const r = await p.op('construction_sites', { name: 'User', limit: 3 });
    assert.ok('result' in r && r.result.ok, JSON.stringify(r));
    const view = r.result.data as CView;
    assert.ok(view.truncated !== undefined, 'cap was hit');
    const notes = view.notes ?? [];
    assert.ok(
      notes.some((n) => /unscanned|MORE candidates/.test(n)),
      'a truncated empty scan flags unscanned candidates',
    );
    assert.ok(
      !notes.some((n) => /no object literal is assignable to interface User in scope/.test(n)),
      'must NOT assert non-existence while candidates remain unscanned',
    );
  } finally {
    await p.dispose();
  }
});

test('a VALUE target is labelled `value`, never mislabelled `type`', async () => {
  const p = await project({
    'tsconfig.json': STRICT,
    'src/v.ts':
      "export const config = { id: 1, name: 'a' };\nexport const other = { id: 2, name: 'b' };\n",
  });
  try {
    const r = await p.op('construction_sites', { name: 'config' });
    assert.ok('result' in r && r.result.ok, JSON.stringify(r));
    const view = r.result.data as CView;
    assert.equal(view.target.kind, 'value', 'a const target is a value, not a type');
    assert.ok(
      (view.notes ?? []).some((n) => /resolves to a VALUE/.test(n)),
      'the value-target caveat is stated',
    );
  } finally {
    await p.dispose();
  }
});

test('a VALUE target with a VACUOUS inferred type still carries the value caveat', async () => {
  // `const x = {}` → inferred type `{}` is vacuous (early short-circuit), but the agent must
  // still be told `x` is a VALUE, not a type (bug-reviewer 2nd pass, Bug 2).
  const p = await project({ 'tsconfig.json': STRICT, 'src/v.ts': 'export const blank = {};\n' });
  try {
    const r = await p.op('construction_sites', { name: 'blank' });
    assert.ok('result' in r && r.result.ok, JSON.stringify(r));
    const view = r.result.data as CView;
    assert.equal(view.sites.length, 0, 'vacuous inferred type → 0 sites');
    const notes = view.notes ?? [];
    assert.ok(
      notes.some((n) => /resolves to a VALUE/.test(n)),
      'value caveat present',
    );
    assert.ok(
      notes.some((n) => /top\/open type/.test(n)),
      'vacuous note present',
    );
  } finally {
    await p.dispose();
  }
});

test('a no-match target yields a 0 answer with an honest note (not silent)', async () => {
  const p = await project({
    'tsconfig.json': STRICT,
    'src/types.ts': 'export interface Unbuilt { a: number; b: string; c: boolean; }\n',
    'src/x.ts': `import type { Unbuilt } from './types';\nexport const near = { a: 1 };\n`,
  });
  try {
    const r = await p.op('construction_sites', { name: 'Unbuilt' });
    assert.ok('result' in r && r.result.ok, JSON.stringify(r));
    const view = r.result.data as CView;
    assert.equal(view.sites.length, 0);
    assert.ok((view.notes ?? []).some((n) => /no object literal is assignable/.test(n)));
  } finally {
    await p.dispose();
  }
});
