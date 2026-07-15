// Edit-safety oracles for CO-MOVING interdependent symbols into ONE module (§16.4). Two planner-level
// root-fixes are exercised, both order-independent and both proven not to weaken the §2.8 gate:
//   PRE-STRIP (t-610634) — moving a symbol into a dest that ALREADY imports it (from the source
//     module) once made the LS emit two overlapping edits to the same `import … from '<source>'`
//     statement → stock TS asserted `Changes overlap` ("cannot move: edits overlap") and the co-move
//     failed unless the caller hand-ordered steps leaf-first. Stripping the dest's pre-import first
//     turns the shape clean, in ANY step order.
//   SELF-IMPORT STRIP (t-242381) — moving a symbol whose dependency already lives in dest made the LS
//     emit `import { Dep } from './dest'` INSIDE ./dest → `Import declaration conflicts with local
//     declaration`, which the gate correctly REFUSED (co-move couldn't complete). The self-import is
//     dropped post-edit (an import from this very file is always redundant).
// Oracles, none golden: the transaction's own verdict, a cold `ts.Program` compile of the post-op
// tree (0 errors), diff(dry)==diff(apply), byte-exact rollback (git porcelain). A NEGATIVE test proves
// a real cross-file dangle still refuses, and a REGRESSION test keeps mutually-recursive co-move clean.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { coldDiagnostics } from '../helpers/cold-ls.ts';
import type { JsonValue } from '../../src/core/json.ts';
import { project, type TestProject } from '../helpers/project.ts';

const TSCONFIG = '{"compilerOptions":{"strict":true,"module":"preserve"}}';
type Proj = TestProject;

type Envelope = { mode: string; diff: string; typecheck: { clean: boolean }; applied?: boolean };

async function txn(
  p: Proj,
  steps: JsonValue,
  apply = false,
): Promise<{ ok: true; env: Envelope } | { ok: false; message: string }> {
  const [r] = await p.request([
    { name: 'transaction', args: { steps }, ...(apply ? { apply: true } : {}) },
  ]);
  if (r === undefined || 'error' in r) assert.fail(`dispatch error: ${JSON.stringify(r)}`);
  if (!r.result.ok) return { ok: false, message: r.result.failure.message };
  return { ok: true, env: r.result.data as unknown as Envelope };
}

async function move(
  p: Proj,
  args: JsonValue,
  apply = false,
): Promise<{ ok: true; env: Envelope } | { ok: false; message: string }> {
  const [r] = await p.request([{ name: 'move_symbol', args, ...(apply ? { apply: true } : {}) }]);
  if (r === undefined || 'error' in r) assert.fail(`dispatch error: ${JSON.stringify(r)}`);
  if (!r.result.ok) return { ok: false, message: r.result.failure.message };
  return { ok: true, env: r.result.data as unknown as Envelope };
}

const read = (p: Proj, rel: string): string => readFileSync(path.join(p.root, rel), 'utf8');

test('co-move: an acyclic chain moved DEPENDENT-FIRST into one dest completes clean (pre-strip)', async () => {
  // a→b→c, moved [a, b, c] (dependent-first). Pre-fix this FAILs at step 1 with `Changes overlap`
  // (dest imports b after step 0, b still deps c in source). Order-independence is the fix: a clean
  // apply in this hostile order proves the root fix, not a leaf-first workaround.
  const steps = [
    { name: 'move_symbol', args: { name: 'a', dest: 'src/dest.ts' } },
    { name: 'move_symbol', args: { name: 'b', dest: 'src/dest.ts' } },
    { name: 'move_symbol', args: { name: 'c', dest: 'src/dest.ts' } },
  ];
  const p = await project({
    'tsconfig.json': TSCONFIG,
    'src/chain.ts':
      'export function c(): number { return 1; }\n' +
      'export function b(): number { return c(); }\n' +
      'export function a(): number { return b(); }\n',
    'src/dest.ts': 'export const placeholder = 1;\n',
  });
  try {
    const dry = await txn(p, steps);
    assert.ok(dry.ok, `dependent-first co-move should not fail: ${JSON.stringify(dry)}`);
    assert.equal(dry.env.typecheck.clean, true, JSON.stringify(dry.env));
    assert.equal(p.git('status', '--porcelain'), ''); // dry-run wrote nothing

    const applied = await txn(p, steps, true);
    assert.ok(applied.ok && applied.env.applied === true, JSON.stringify(applied));
    assert.equal(applied.env.diff, dry.env.diff, 'diff(dry) === diff(apply)');
    assert.deepEqual(coldDiagnostics(p.root), []); // cold-Program oracle: 0 errors
    const dest = read(p, 'src/dest.ts');
    for (const fn of ['a', 'b', 'c']) assert.match(dest, new RegExp(`function ${fn}\\(`));
    // Co-resident: every reference is now local — dest imports NOTHING from the old module.
    assert.doesNotMatch(dest, /import .* from ['"]\.\/chain['"]/, 'no residual source import');
    assert.doesNotMatch(read(p, 'src/chain.ts'), /function [abc]\(/, 'symbols left source');
  } finally {
    await p.dispose();
  }
});

test('co-move: interdependent interfaces extract+move into one NEW dest, no self-import (self-strip)', async () => {
  // extract CssProperty → NEW css-types.ts, then move the three dependents in. Pre-fix each move
  // emitted a self-import `import { … } from './css-types'` INTO css-types.ts → the gate refused.
  const steps = [
    { name: 'extract_symbol', args: { name: 'CssProperty', dest: 'src/css-types.ts' } },
    { name: 'move_symbol', args: { name: 'CssStyle', dest: 'src/css-types.ts' } },
    { name: 'move_symbol', args: { name: 'CssRule', dest: 'src/css-types.ts' } },
    { name: 'move_symbol', args: { name: 'MatchedStyles', dest: 'src/css-types.ts' } },
  ];
  const p = await project({
    'tsconfig.json': TSCONFIG,
    'src/types.ts':
      'export interface CssProperty { name: string; value: string; }\n' +
      'export interface CssStyle { props: CssProperty[]; }\n' +
      'export interface CssRule { style: CssStyle; }\n' +
      'export interface MatchedStyles { rules: CssRule[]; }\n',
  });
  try {
    const dry = await txn(p, steps);
    assert.ok(dry.ok, `interface co-move should not fail: ${JSON.stringify(dry)}`);
    assert.equal(dry.env.typecheck.clean, true, JSON.stringify(dry.env));

    const applied = await txn(p, steps, true);
    assert.ok(applied.ok && applied.env.applied === true, JSON.stringify(applied));
    assert.equal(applied.env.diff, dry.env.diff, 'diff(dry) === diff(apply)');
    assert.deepEqual(coldDiagnostics(p.root), []);
    const cssTypes = read(p, 'src/css-types.ts');
    assert.doesNotMatch(cssTypes, /import .* from ['"]\.\/css-types['"]/, 'no self-import');
    for (const iface of ['CssProperty', 'CssStyle', 'CssRule', 'MatchedStyles']) {
      assert.match(cssTypes, new RegExp(`interface ${iface}`));
    }
  } finally {
    await p.dispose();
  }
});

test('move_symbol (standalone): dest that pre-imports the moved symbol completes clean (pre-strip)', async () => {
  // The pre-strip is a MOVE-planner fix, not a transaction one: the same shape refuses on a lone op.
  const p = await project({
    'tsconfig.json': TSCONFIG,
    'src/chain.ts':
      'export function c(): number { return 1; }\nexport function b(): number { return c(); }\n',
    'src/dest.ts': 'import { b } from "./chain";\nexport const use = b;\n',
  });
  try {
    const applied = await move(p, { name: 'b', dest: 'src/dest.ts' }, true);
    assert.ok(applied.ok && applied.env.applied === true, JSON.stringify(applied));
    assert.deepEqual(coldDiagnostics(p.root), []);
    const dest = read(p, 'src/dest.ts');
    assert.match(dest, /function b\(/, 'b landed in dest');
    assert.match(dest, /import \{ c \} from ['"]\.\/chain['"]/, "b's remaining dep imported");
    assert.doesNotMatch(dest, /import \{ b \}/, 'stale pre-import of b removed');
  } finally {
    await p.dispose();
  }
});

test('move_symbol (standalone): moving a symbol whose dep is already in dest emits no self-import', async () => {
  const p = await project({
    'tsconfig.json': TSCONFIG,
    'src/css-types.ts': 'export interface CssProperty { name: string; value: string; }\n',
    'src/types.ts':
      'import { CssProperty } from "./css-types";\nexport interface CssStyle { props: CssProperty[]; }\n',
  });
  try {
    const applied = await move(p, { name: 'CssStyle', dest: 'src/css-types.ts' }, true);
    assert.ok(applied.ok && applied.env.applied === true, JSON.stringify(applied));
    assert.deepEqual(coldDiagnostics(p.root), []);
    assert.doesNotMatch(read(p, 'src/css-types.ts'), /import .* from ['"]\.\/css-types['"]/);
  } finally {
    await p.dispose();
  }
});

test('co-move gate NOT weakened: a real cross-file dangle still REFUSES, nothing written', async () => {
  // A re-export barrel of the moved symbol is NOT repointed by the LS → moving b leaves
  // `export { b } from './chain'` dangling. The §2.8 gate must still catch it even though the
  // pre-strip removed dest's own import of b — the strips must not mask a genuine post-edit error.
  const p = await project({
    'tsconfig.json': TSCONFIG,
    'src/chain.ts':
      'export function c(): number { return 1; }\nexport function b(): number { return c(); }\n',
    'src/dest.ts': 'import { b } from "./chain";\nexport const use = b;\n',
    'src/barrel.ts': 'export { b } from "./chain";\n',
  });
  try {
    const r = await move(p, { name: 'b', dest: 'src/dest.ts' }, true);
    assert.ok(r.ok, JSON.stringify(r));
    assert.notEqual(r.env.applied, true, 'a dangling barrel re-export must refuse');
    assert.equal(r.env.typecheck.clean, false);
    assert.equal(p.git('status', '--porcelain'), ''); // refused → nothing written
  } finally {
    await p.dispose();
  }
});

test('pre-strip NEVER strips an aliased same-named import (no silent rebind)', async () => {
  // dest imports a DIFFERENT export `x` under the local alias `b` (`{ x as b }`); source also has a
  // real `b`. Moving source's real `b` into dest must NOT strip `import { x as b }` — that binds `x`,
  // not the moved symbol — else `use` silently re-binds from x(→10) to the moved b(→1), typecheck-clean
  // (a §7 capture the gate can't see inside dest). The pre-strip matches the EXPORTED name un-aliased,
  // so it leaves this import alone; the honest outcome is a collision refusal.
  const p = await project({
    'tsconfig.json': TSCONFIG,
    'src/source.ts':
      'export function x(): number { return 10; }\nexport function b(): number { return 1; }\n',
    'src/dest.ts': 'import { x as b } from "./source";\nexport const use = b();\n',
  });
  try {
    // Address by position to bypass the name-ambiguity guard (two `b`-named things reachable).
    const r = await move(p, { file: 'src/source.ts', line: 2, col: 17, dest: 'src/dest.ts' }, true);
    assert.ok(r.ok, JSON.stringify(r));
    assert.notEqual(
      r.env.applied,
      true,
      'aliased same-named import stripped → would silently rebind',
    );
    assert.equal(r.env.typecheck.clean, false);
    assert.equal(p.git('status', '--porcelain'), ''); // refused → nothing written
  } finally {
    await p.dispose();
  }
});

test('co-move regression: mutually-recursive functions still co-move clean', async () => {
  const steps = [
    { name: 'move_symbol', args: { name: 'ping', dest: 'src/dest.ts' } },
    { name: 'move_symbol', args: { name: 'pong', dest: 'src/dest.ts' } },
  ];
  const p = await project({
    'tsconfig.json': TSCONFIG,
    'src/mr.ts':
      'export function ping(n: number): number { return n > 0 ? pong(n - 1) : 0; }\n' +
      'export function pong(n: number): number { return n > 0 ? ping(n - 1) : 0; }\n',
    'src/dest.ts': 'export const placeholder = 1;\n',
  });
  try {
    const applied = await txn(p, steps, true);
    assert.ok(applied.ok && applied.env.applied === true, JSON.stringify(applied));
    assert.deepEqual(coldDiagnostics(p.root), []);
    const dest = read(p, 'src/dest.ts');
    assert.match(dest, /function ping\(/);
    assert.match(dest, /function pong\(/);
    assert.doesNotMatch(dest, /import .* from ['"]\.\/mr['"]/);
  } finally {
    await p.dispose();
  }
});
