// The write gate's diagnostics builder (program-gate-builder.ts): which state each pass chains from,
// and what that costs. Equivalence on the spike traps lives in
// test/differential/gate-builder-traps.test.ts; oracle and work spy in test/helpers/gate-builder.ts.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync, unlinkSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import ts from 'typescript';
import { createTsProjectHost } from '../../src/plugins/ts/ls-host.ts';
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

const CHAIN: Files = {
  'a.ts': 'export const v = 1;',
  'b.ts': "import { v } from './a';\nexport const b = v;",
  'c.ts': "import { v } from './a';\nexport const c = v;",
  ...DECOYS,
};
const NAMES = Object.keys(CHAIN);

function withHost(
  files: Files,
  fn: (dir: string, host: ReturnType<typeof createTsProjectHost>) => void,
) {
  const dir = project(files);
  const host = createTsProjectHost(dir);
  try {
    fn(dir, host);
  } finally {
    host.dispose();
    rmSync(dir, { recursive: true, force: true });
  }
}

test('an unchanged disk costs the baseline nothing; an edit rechecks only what it can affect', () => {
  withHost(CHAIN, (dir, host) => {
    const ctx = host.gateHostCtx();
    const edit = (n: number): Files => ({
      'b.ts': `import { v } from './a';\nexport const b = v; // ${n}`,
    });
    gateAcross(ctx, edits(edit(1)), scopeOf(NAMES, edit(1)));
    gateAcross(ctx, edits(edit(2)), scopeOf(NAMES, edit(2)));
    const work = spy(host, dir);
    const g = gateAcross(ctx, edits(edit(3)), scopeOf(NAMES, edit(3)));
    assert.deepEqual(work.checked, ['b.ts'], 'baseline copied whole; overlay rechecked b.ts alone');
    assert.deepEqual(g, oracleGate(dir, edit(3), scopeOf(NAMES, edit(3))));
  });
});

test('post-apply chains from the state that gated the written bytes, even past another gate', () => {
  withHost(CHAIN, (dir, host) => {
    const ctx = host.gateHostCtx();
    // A d.ts-signature change: chaining from the DISK state would recheck b.ts and c.ts too.
    const apply: Files = { 'a.ts': 'export const v: number = 1;' };
    const other: Files = { 'a.ts': "export const v = 'x';" };
    gateAcross(ctx, edits(apply), scopeOf(NAMES, apply));
    gateAcross(ctx, edits(other), scopeOf(NAMES, other)); // a dry-run of a different edit between
    host.reindex(writeDisk(dir, apply));
    const work = spy(host, dir);
    // The narrow written-files scope `verifyAfterWrite` passes: on the builder only because the
    // gate of these bytes ran there.
    const scope = { anchor: [src('a.ts')], check: [src('a.ts')] };
    const after = diagnosticsAcross(host.gateHostCtx(), scope, undefined, {
      files: edits(apply),
      removed: [],
    });
    assert.deepEqual(work.checked, ['a.ts'], 'only the written file was rechecked');
    assert.deepEqual(sorted(after), sorted(oracleDisk(dir, scope)));
  });
});

test('a narrow check scope stays on the LS path', () => {
  withHost(CHAIN, (dir, host) => {
    const edit: Files = { 'b.ts': "import { v } from './a';\nexport const b: string = v;" };
    const scope = { anchor: [src('b.ts')], check: [src('b.ts')] };
    const work = spy(host, dir);
    const g = gateAcross(host.gateHostCtx(), edits(edit), scope);
    // The LS reaches the checker through Program internals the spy does not see; a builder pass
    // calls the patched method — so an empty log means no builder pass ran.
    assert.deepEqual(work.checked, [], 'no builder pass');
    assert.ok(g.overlay.length > 0);
    assert.deepEqual(g, oracleGate(dir, edit, scope));
  });
});

test('a foreign overlay state is a sound parent — only a costlier one', () => {
  withHost(CHAIN, (dir, host) => {
    const gated: Files = { 'a.ts': "export const v = 'x';" };
    const real: Files = { 'a.ts': 'export const v: string = 1;' };
    gateAcross(host.gateHostCtx(), edits(gated), scopeOf(NAMES, gated));
    host.reindex(writeDisk(dir, real));
    const scope = scopeOf(NAMES, real);
    // Claims the gated bytes were written; disk holds others → the parent is the wrong overlay.
    const after = diagnosticsAcross(host.gateHostCtx(), scope, undefined, {
      files: edits(gated),
      removed: [],
    });
    assert.ok(after.length > 0, 'the real disk carries an error');
    assert.deepEqual(sorted(after), sorted(oracleDisk(dir, scope)));
  });
});

test('a path that leaves the program and returns with a new body is rechecked', () => {
  const files: Files = {
    'a.ts': 'export const x: number = 1;',
    'u.ts': "import { x } from './a';\nexport const y = x;",
  };
  withHost(files, (dir, host) => {
    const names = ['a.ts', 'u.ts'];
    gateAcross(host.gateHostCtx(), [], scopeOf(names, {}));
    // checkout #1: a.ts deleted, n.ts added (structural → the re-glob drops a.ts)
    unlinkSync(path.join(dir, 'src/a.ts'));
    writeFileSync(path.join(dir, 'src/n.ts'), 'export const n = 1;');
    host.reindex([src('a.ts'), src('n.ts')]);
    // checkout #2: a.ts back with the same imports and an error in its body
    writeFileSync(path.join(dir, 'src/a.ts'), "export const x: number = 'no';");
    host.reindex([src('a.ts')]);
    const scope = scopeOf([...names, 'n.ts'], {});
    const g = gateAcross(host.gateHostCtx(), [], scope);
    assert.ok(
      g.baseline.some((d) => d.file === src('a.ts')),
      'the new body was checked',
    );
    assert.deepEqual(sorted(g.baseline), sorted(oracleGate(dir, {}, scope).baseline));
  });
});

test('an edit touching most of the program restarts the chain cold and stays exact', () => {
  const many: Files = Object.fromEntries(
    Array.from({ length: 60 }, (_, i) => [`m${i}.ts`, `export const m${i}: number = ${i};`]),
  );
  const files = { ...many, ...DECOYS };
  withHost(files, (dir, host) => {
    const names = Object.keys(files);
    gateAcross(host.gateHostCtx(), [], scopeOf(names, {}));
    const hub: Files = Object.fromEntries(
      Object.keys(many).map((n, i) => [n, `export const m${i}: string = ${i};`]),
    );
    const work = spy(host, dir);
    const g = gateAcross(host.gateHostCtx(), edits(hub), scopeOf(names, hub));
    assert.ok(work.checked.includes('z.ts'), 'a cold pass rechecks even the decoy');
    assert.deepEqual(g, oracleGate(dir, hub, scopeOf(names, hub)));
  });
});

test('the builder passes poll the host cancellation predicate', () => {
  withHost(CHAIN, (dir, host) => {
    const ctx = { ...host.gateHostCtx(), cancel: () => true };
    // The checker polls the token only at function-like nodes — the edit must contain one.
    const edit: Files = { 'b.ts': 'export function b() { return 2; }' };
    assert.throws(
      () => gateAcross(ctx, edits(edit), scopeOf(NAMES, edit)),
      (e: unknown) => e instanceof ts.OperationCanceledException,
    );
    const ok = gateAcross(host.gateHostCtx(), [], scopeOf(NAMES, {}));
    assert.deepEqual(ok, oracleGate(dir, {}, scopeOf(NAMES, {})));
  });
});
