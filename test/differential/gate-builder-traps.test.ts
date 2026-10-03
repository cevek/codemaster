// The write gate's diagnostics builder == the full LS pass on the equivalence traps of the spike
// t-820012, through the chain a mutation drives: disk → overlay → post-apply → disk. The benign edit
// is landed on disk first, so the trap overlay meets REAL d.ts signatures in the disk state (a cold
// state stores file versions as signatures, which invalidates the whole closure and would make the
// trap pass for the wrong reason). Oracle and helpers: test/helpers/gate-builder.ts.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, rmSync } from 'node:fs';
import * as path from 'node:path';
import { createTsProjectHost, type TsProjectHost } from '../../src/plugins/ts/ls-host.ts';
import { diagnosticsAcross, gateAcross } from '../../src/plugins/ts/program-gate.ts';
import {
  DECOYS,
  edits,
  oracleDisk,
  oracleGate,
  project,
  scopeOf,
  sorted,
  spy,
  src,
  writeDisk,
  type Files,
} from '../helpers/gate-builder.ts';

interface Trap {
  name: string;
  files: Files;
  benign: Files;
  trap: Files;
  removed?: string[];
  /** The file the trap's introduced error lands in — the positive control. */
  expect: string;
  options?: Record<string, unknown>;
  /** A global-scope change invalidates every file by TS's own rule — no decoy claim there. */
  global?: boolean;
}

const DECLARATION_OPTIONS = [
  { declaration: true, noEmit: false, emitDeclarationOnly: true, outDir: 'out' },
  { declaration: true },
  { composite: true, noEmit: false, emitDeclarationOnly: true, outDir: 'out' },
];

const TRAPS: Trap[] = [
  {
    name: 'type passthrough, 2 hops',
    files: {
      'a.ts': 'export interface T { v: number }',
      'b.ts': "export type { T as U } from './a';",
      'b2.ts': "import type { U } from './b';\nexport type W = U;",
      'c.ts': "import type { W } from './b2';\nexport const x: W = { v: 1 };",
    },
    benign: { 'a.ts': 'export interface T { v: number } // c' },
    trap: { 'a.ts': 'export interface T { v: string }' },
    expect: 'c.ts',
  },
  {
    name: 'export * barrel retype',
    files: {
      'a.ts': 'export const v = 1;',
      'b.ts': "export * from './a';",
      'c.ts': "import { v } from './b';\nexport const n: number = v;",
    },
    benign: { 'a.ts': 'export const v = 1; // c' },
    trap: { 'a.ts': "export const v = 'x';" },
    expect: 'c.ts',
  },
  {
    name: 'declare global moved to a non-module file',
    files: {
      'g.ts': 'export const k = 1;\ndeclare global { var foo: string }',
      'u.ts': 'export const f = (): number => foo.length;',
    },
    benign: { 'g.ts': 'export const k = 1; // c\ndeclare global { var foo: string }' },
    trap: { 'g.ts': 'export const k = 1;', 'g2.ts': 'declare global { var foo: string }' },
    expect: 'u.ts',
    global: true,
  },
  {
    name: 'tombstone with a missed importer',
    files: {
      'a.ts': 'export const v = 1;',
      'b.ts': "import { v } from './a';\nexport const b = v;",
      'c.ts': "import { v } from './a';\nexport const c = v;",
    },
    benign: { 'a.ts': 'export const v = 1; // c' },
    trap: {
      'a2.ts': 'export const v = 1;',
      'b.ts': "import { v } from './a2';\nexport const b = v;",
    },
    removed: ['a.ts'],
    expect: 'c.ts',
  },
  {
    name: 'const enum value',
    files: {
      'a.ts': 'export const enum E { A = 1 }',
      'b.ts': "import { E } from './a';\nexport const n: 1 = E.A;",
    },
    benign: { 'a.ts': 'export const enum E { A = 1 } // c' },
    trap: { 'a.ts': 'export const enum E { A = 2 }' },
    expect: 'b.ts',
  },
  {
    name: 'module augmentation from a file nobody imports',
    files: {
      'a.ts': 'export interface I { x: number }',
      'aug.ts': "export {};\ndeclare module './a' { interface I { y: string } }",
      'c.ts': "import type { I } from './a';\nexport const i: I = { x: 1, y: 's' };",
    },
    benign: { 'aug.ts': "export {}; // c\ndeclare module './a' { interface I { y: string } }" },
    trap: { 'aug.ts': "export {};\ndeclare module './a' { interface I { y: number } }" },
    expect: 'c.ts',
  },
  {
    name: 'non-module script changes a global',
    files: {
      'glob.ts': 'declare var cfg: { n: number };',
      'u.ts': 'export const v: number = cfg.n;',
    },
    benign: { 'glob.ts': 'declare var cfg: { n: number }; // c' },
    trap: { 'glob.ts': 'declare var cfg: { n: string };' },
    expect: 'u.ts',
    global: true,
  },
  ...DECLARATION_OPTIONS.map(
    (options): Trap => ({
      name: `declaration diagnostics under ${JSON.stringify(options)}`,
      files: {
        'a.ts': 'export const make = () => class { x = 1; };',
        'b.ts': "import { make } from './a';\nexport const K = make();",
      },
      benign: { 'a.ts': 'export const make = () => class { x = 1; }; // c' },
      trap: { 'a.ts': 'export const make = () => class { private x = 1; };' },
      expect: 'b.ts',
      options,
    }),
  ),
];

/** Write `files`/`removed` to disk and run the post-apply recheck the way `verifyAfterWrite` does. */
function landOnDisk(
  host: TsProjectHost,
  dir: string,
  names: readonly string[],
  files: Files,
  removed: readonly string[] = [],
) {
  host.reindex(writeDisk(dir, files, removed));
  const scope = scopeOf(names, files, removed);
  const after = diagnosticsAcross(host.gateHostCtx(), scope, undefined, {
    files: edits(files),
    removed: removed.map(src),
  });
  assert.deepEqual(sorted(after), sorted(oracleDisk(dir, scope)), 'post-apply recheck');
  return after;
}

for (const t of TRAPS) {
  test(`builder == full pass through disk → overlay → post-apply → disk: ${t.name}`, () => {
    const files = { ...t.files, ...DECOYS };
    const dir = project(files, t.options);
    const host = createTsProjectHost(dir);
    const names = Object.keys(files);
    const removed = t.removed ?? [];
    try {
      const gate = (edit: Files, rm: readonly string[] = []) => {
        const scope = scopeOf(names, edit, rm);
        const got = gateAcross(host.gateHostCtx(), edits(edit), scope);
        const want = oracleGate(dir, edit, scope);
        assert.deepEqual(sorted(got.baseline), sorted(want.baseline), 'baseline');
        assert.deepEqual(sorted(got.overlay), sorted(want.overlay), 'overlay');
        return got;
      };
      gate(t.benign);
      landOnDisk(host, dir, names, t.benign);
      const work = spy(host, dir);
      const trapped = gate(t.trap, removed);
      assert.ok(
        trapped.overlay.some((d) => d.file === src(t.expect)),
        'positive control: the trap introduces an error',
      );
      if (t.global !== true) {
        assert.ok(!work.checked.includes('z.ts'), `the decoy was not rechecked (${work.checked})`);
      }
      const after = landOnDisk(host, dir, names, t.trap, removed);
      assert.ok(
        after.some((d) => d.file === src(t.expect)),
        'post-apply sees the written error',
      );
      const revert = Object.fromEntries(
        [...Object.keys(t.trap), ...removed]
          .filter((n) => n in files)
          .map((n) => [n, files[n] as string]),
      );
      gate(revert);
      assert.ok(!existsSync(path.join(dir, 'out')), 'the builder wrote nothing');
    } finally {
      host.dispose();
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

test('assumeChangesOnlyAffectDirectDependencies turns the builder path off', () => {
  const t = TRAPS[0] as Trap;
  const files = { ...t.files, ...DECOYS };
  const dir = project(files, { assumeChangesOnlyAffectDirectDependencies: true });
  const host = createTsProjectHost(dir);
  try {
    const names = Object.keys(files);
    gateAcross(host.gateHostCtx(), edits(t.benign), scopeOf(names, t.benign));
    landOnDisk(host, dir, names, t.benign);
    const g = gateAcross(host.gateHostCtx(), edits(t.trap), scopeOf(names, t.trap));
    assert.ok(
      g.overlay.some((d) => d.file === src('c.ts')),
      'the 2-hop error is caught — the incremental model would skip c.ts under this option',
    );
  } finally {
    host.dispose();
    rmSync(dir, { recursive: true, force: true });
  }
});
