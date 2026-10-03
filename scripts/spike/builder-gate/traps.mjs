// Spike t-820012 — equivalence traps. Each trap is an inline project + a chain of overlay states.
// For every state: builder-chain diagnostics vs a fresh full check on the same source files.
// Positive control: the trap state's FULL pass must contain the expected error, else the trap
// proves nothing (an equivalence over two empty sets).
//
//   node scripts/spike/builder-gate/traps.mjs

import ts from 'typescript';
import { createHost, builderPass, fullPass, compare, lsKeys } from './lib.mjs';

const R = '/spike';
const base = {
  strict: true,
  noEmit: true,
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  types: [],
  lib: ['lib.es2022.d.ts'],
};

/** step = {name, files?:{rel:content}, removed?:[rel], expect?:{file, code}} — files/removed are
 *  the WHOLE overlay for that state (relative to the base tree), as setOverlay replaces. */
const TRAPS = [
  {
    name: 'type passthrough (B d.ts text unchanged)',
    files: {
      'a.ts': 'export type T = number;',
      'b.ts': "import type { T } from './a';\nexport type U = T;",
      'c.ts': "import type { U } from './b';\nexport const x: U = 1;",
    },
    steps: [
      { name: 'benign', files: { 'a.ts': 'export type T = number; // c' } },
      { name: 'TRAP', files: { 'a.ts': 'export type T = string;' }, expect: { file: 'c.ts', code: 2322 } },
    ],
  },
  {
    name: 'passthrough, 2 hops',
    files: {
      'a.ts': 'export interface T { v: number }',
      'b.ts': "export type { T as U } from './a';",
      'b2.ts': "import type { U } from './b';\nexport type W = U;",
      'c.ts': "import type { W } from './b2';\nexport const x: W = { v: 1 };",
    },
    steps: [
      { name: 'benign', files: { 'a.ts': 'export interface T { v: number } // c' } },
      { name: 'TRAP', files: { 'a.ts': 'export interface T { v: string }' }, expect: { file: 'c.ts', code: 2322 } },
    ],
  },
  {
    name: 'export * barrel',
    files: {
      'a.ts': 'export const v = 1;',
      'b.ts': "export * from './a';",
      'c.ts': "import { v } from './b';\nexport const n: number = v;",
    },
    steps: [
      { name: 'benign', files: { 'a.ts': 'export const v = 1; // c' } },
      { name: 'TRAP retype', files: { 'a.ts': "export const v = 'x';" }, expect: { file: 'c.ts', code: 2322 } },
      { name: 'TRAP remove', files: { 'a.ts': 'export const w = 1;' }, expect: { file: 'c.ts', code: 2305 } },
    ],
  },
  {
    name: 'declare global moved out (block extracted to a non-module file → augmentation lost)',
    files: {
      'g.ts': 'export const k = 1;\ndeclare global { var foo: string }',
      'u.ts': 'export const f = (): number => foo.length;',
    },
    steps: [
      { name: 'benign', files: { 'g.ts': 'export const k = 1; // c\ndeclare global { var foo: string }' } },
      {
        name: 'TRAP',
        files: { 'g.ts': 'export const k = 1;', 'g2.ts': 'declare global { var foo: string }' },
        expect: { file: 'u.ts', code: 2304 },
      },
    ],
  },
  {
    name: 'tombstone with a missed importer (move a.ts → a2.ts, c not rewritten)',
    files: {
      'a.ts': 'export const v = 1;',
      'b.ts': "import { v } from './a';\nexport const b = v;",
      'c.ts': "import { v } from './a';\nexport const c = v;",
    },
    steps: [
      { name: 'benign', files: { 'a.ts': 'export const v = 1; // c' } },
      {
        name: 'TRAP',
        files: { 'a2.ts': 'export const v = 1;', 'b.ts': "import { v } from './a2';\nexport const b = v;" },
        removed: ['a.ts'],
        expect: { file: 'c.ts', code: 2307 },
      },
    ],
  },
  {
    name: 'const enum value',
    files: {
      'a.ts': 'export const enum E { A = 1 }',
      'b.ts': "import { E } from './a';\nexport const n: 1 = E.A;",
    },
    steps: [
      { name: 'benign', files: { 'a.ts': 'export const enum E { A = 1 } // c' } },
      { name: 'TRAP', files: { 'a.ts': 'export const enum E { A = 2 }' }, expect: { file: 'b.ts', code: 2322 } },
    ],
  },
  {
    name: 'module augmentation from a file nobody imports',
    files: {
      'a.ts': 'export interface I { x: number }',
      'aug.ts': "export {};\ndeclare module './a' { interface I { y: string } }",
      'c.ts': "import type { I } from './a';\nexport const i: I = { x: 1, y: 's' };",
    },
    steps: [
      { name: 'benign', files: { 'aug.ts': "export {}; // c\ndeclare module './a' { interface I { y: string } }" } },
      {
        name: 'TRAP',
        files: { 'aug.ts': "export {};\ndeclare module './a' { interface I { y: number } }" },
        expect: { file: 'c.ts', code: 2322 },
      },
    ],
  },
  {
    name: 'non-module script changes a global',
    files: {
      'glob.ts': 'declare var cfg: { n: number };',
      'u.ts': 'export const v: number = cfg.n;',
    },
    steps: [
      { name: 'benign', files: { 'glob.ts': 'declare var cfg: { n: number }; // c' } },
      { name: 'TRAP', files: { 'glob.ts': 'declare var cfg: { n: string };' }, expect: { file: 'u.ts', code: 2322 } },
    ],
  },
];

// Unrelated files in every trap: if the builder rechecks THEM on a step, it is passing through
// (doing full work), and an EQUAL verdict on that step says nothing about incremental soundness.
const DECOYS = {
  'z.ts': 'export const z = 1;',
  'zu.ts': "import { z } from './z';\nexport const zz: number = z;",
};

function runTrap(trap, options, label) {
  const host = createHost({ root: R, files: { ...trap.files, ...DECOYS }, options });
  const benign = trap.steps[0];
  const states = [{ name: 'base' }, benign, { ...benign, name: 'benign-again' }, ...trap.steps.slice(1), { name: 'revert' }];
  let prev;
  const rows = [];
  for (const st of states) {
    if (st.name === 'base' || st.name === 'revert') host.clearOverlay();
    else
      host.setOverlay(
        Object.entries(st.files ?? {}).map(([k, v]) => ({ abs: `${R}/${k}`, content: v })),
        (st.removed ?? []).map((r) => `${R}/${r}`),
      );
    const b = builderPass(host, prev);
    const f = fullPass(b.program, host);
    const cmp = compare(b.keys, f.keys);
    let control = '';
    if (st.expect) {
      const hit = f.keys.some((k) => k.startsWith(`${R}/${st.expect.file}|`) && k.split('|')[3] === String(st.expect.code));
      control = hit ? ' control=ok' : ' control=MISSING(trap proves nothing)';
    }
    const rech = b.rechecked.map((x) => x.slice(R.length + 1)).join(',');
    rows.push(
      `  ${st.name.padEnd(13)} ${cmp.equal ? 'EQUAL' : 'DIFF '} drained=${b.drained} rechecked=[${rech}]${control}` +
        (cmp.equal ? '' : `\n      builder-only=${JSON.stringify(cmp.onlyA)}\n      full-only=${JSON.stringify(cmp.onlyB)}`),
    );
    prev = b.builder;
  }
  console.log(`${label} — ${trap.name}\n${rows.join('\n')}`);
}

for (const iso of [false, true]) {
  for (const trap of TRAPS) runTrap(trap, { ...base, isolatedModules: iso }, `iso=${iso}`);
}
// A user-settable compilerOption that switches the builder's transitive invalidation off — the
// builder path must refuse a project that sets it (expected: DIFF on the passthrough trap).
runTrap(TRAPS[0], { ...base, assumeChangesOnlyAffectDirectDependencies: true }, 'assumeChangesOnlyAffectDirectDependencies');

// BRANCHING: a gate keeps the disk-state builder B0 and derives EVERY overlay pass from it
// (B1 = f(P_x, B0), later B2 = f(P_y, B0)) — valid only if deriving B1 does not mutate B0.
// Then the realistic post-apply step: disk now holds the overlay bytes under new versions → derive
// from the overlay builder; same text ⇒ same signatures ⇒ only the touched files recheck.
for (const iso of [false, true]) {
  const files = { ...TRAPS[0].files, ...DECOYS };
  const host = createHost({ root: R, files, options: { ...base, isolatedModules: iso } });
  const at = (label, b) => {
    const f = fullPass(b.program, host);
    const cmp = compare(b.keys, f.keys);
    console.log(`  ${label.padEnd(26)} ${cmp.equal ? 'EQUAL' : `DIFF ${JSON.stringify(cmp)}`} rechecked=[${b.rechecked.map((x) => x.slice(R.length + 1))}] diags=${f.keys.length}`);
  };
  console.log(`iso=${iso} — branching from a kept baseline builder`);
  const b0 = builderPass(host, undefined);
  at('B0 base', b0);
  host.setOverlay([{ abs: `${R}/a.ts`, content: 'export type T = string;' }]);
  const b1 = builderPass(host, b0.builder);
  at('B1 = (T=string, B0)', b1);
  host.setOverlay([{ abs: `${R}/a.ts`, content: 'export type T = number; export const q = 1;' }]);
  const b2 = builderPass(host, b0.builder);
  at('B2 = (q added, B0) branch', b2);
  host.setOverlay([{ abs: `${R}/a.ts`, content: 'export type T = string;' }]);
  const b3 = builderPass(host, b1.builder);
  at('B3 = (T=string again, B1)', b3);
  host.clearOverlay();
  const b4 = builderPass(host, b0.builder);
  at('B4 = (disk, B0) branch', b4);
}

// declaration:true parity — LS.getSemanticDiagnostics appends declaration-emit diagnostics, the
// builder's getSemanticDiagnostics does not.
{
  const host = createHost({
    root: R,
    files: { 'd.ts': 'export const C = class { private x = 1 };' },
    options: { ...base, declaration: true, noEmit: false, emitDeclarationOnly: true },
  });
  const b = builderPass(host, undefined);
  const ls = lsKeys(host);
  const cmp = compare(b.keys, ls);
  console.log(
    `declaration:true parity builder vs LS: ${cmp.equal ? 'EQUAL' : 'DIFF'} builder-only=${JSON.stringify(cmp.onlyA)} ls-only=${JSON.stringify(cmp.onlyB)}`,
  );
}
