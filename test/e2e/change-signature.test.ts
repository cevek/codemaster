// Stage E edit-safety oracle for change_signature (§16.4) — positional remove/reorder at the
// declaration + every call site. Oracle: a cold ts.Program compile (a wrong arg rewrite
// surfaces as a type error), diff(dry)==diff(apply), and the §2.8 safety gate (removing a
// parameter still used in the body is REFUSED, never silently applied).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { coldDiagnostics as coldTscErrors } from '../helpers/cold-ls.ts';
import type { JsonValue } from '../../src/core/json.ts';
import { project } from '../helpers/project.ts';

const TSCONFIG = '{"compilerOptions":{"strict":true,"module":"preserve"}}';

type Envelope = { mode: string; diff: string; typecheck: { clean: boolean }; applied?: boolean };
type Proj = Awaited<ReturnType<typeof project>>;

async function change(p: Proj, args: JsonValue, apply = false): Promise<Envelope> {
  const [r] = await p.request([
    { name: 'change_signature', args, ...(apply ? { apply: true } : {}) },
  ]);
  if (r === undefined || 'error' in r) assert.fail(`dispatch error: ${JSON.stringify(r)}`);
  assert.ok(r.result.ok, `expected ok, got ${JSON.stringify(r)}`);
  return r.result.data as unknown as Envelope;
}

test('change_signature: reorder rewrites the declaration and every call site', async () => {
  const p = await project({
    'tsconfig.json': TSCONFIG,
    'src/api.ts': 'export const greet = (name: string, n: number): string => name + n;\n',
    'src/use.ts':
      "import { greet } from './api';\nexport const a = greet('hi', 3);\nexport const b = greet('yo', 7);\n",
  });
  try {
    const dry = await change(p, { name: 'greet', reorder: [1, 0] });
    assert.equal(dry.typecheck.clean, true);
    assert.equal(p.git('status', '--porcelain'), '');

    const applied = await change(p, { name: 'greet', reorder: [1, 0] }, true);
    assert.equal(applied.typecheck.clean, true);
    assert.equal(applied.diff, dry.diff); // diff(dry) === diff(apply)
    assert.deepEqual(coldTscErrors(p.root), []);
    assert.match(
      readFileSync(path.join(p.root, 'src/api.ts'), 'utf8'),
      /greet = \(n: number, name: string\)/,
    );
    assert.match(readFileSync(path.join(p.root, 'src/use.ts'), 'utf8'), /greet\(3, ['"]hi['"]\)/);
    assert.match(readFileSync(path.join(p.root, 'src/use.ts'), 'utf8'), /greet\(7, ['"]yo['"]\)/);
  } finally {
    await p.dispose();
  }
});

test('change_signature: removeParam drops an unused parameter and its arguments', async () => {
  const p = await project({
    'tsconfig.json': TSCONFIG,
    'src/api.ts':
      'export const greet = (name: string, loud: boolean, n: number): string => name + n;\n',
    'src/use.ts': "import { greet } from './api';\nexport const a = greet('hi', true, 3);\n",
  });
  try {
    const applied = await change(p, { name: 'greet', removeParam: 1 }, true);
    assert.equal(applied.typecheck.clean, true);
    assert.deepEqual(coldTscErrors(p.root), []);
    assert.match(
      readFileSync(path.join(p.root, 'src/api.ts'), 'utf8'),
      /greet = \(name: string, n: number\)/,
    );
    assert.match(readFileSync(path.join(p.root, 'src/use.ts'), 'utf8'), /greet\(['"]hi['"], 3\)/);
  } finally {
    await p.dispose();
  }
});

test('change_signature: removing a parameter still used in the body is REFUSED (§2.8)', async () => {
  const p = await project({
    'tsconfig.json': TSCONFIG,
    'src/api.ts': 'export const greet = (name: string, loud: boolean): string => name + loud;\n',
    'src/use.ts': "import { greet } from './api';\nexport const a = greet('hi', true);\n",
  });
  try {
    const r = await change(p, { name: 'greet', removeParam: 1 }, true);
    assert.equal(r.typecheck.clean, false); // body still references `loud`
    assert.equal(r.applied, false); // refused — nothing written
    assert.equal(p.git('status', '--porcelain'), '');
  } finally {
    await p.dispose();
  }
});

test('change_signature: reorder is REFUSED when a call omits trailing args (silent mis-bind risk)', async () => {
  // reorder + omitted optionals + same-typed params would compile clean but mis-bind — the
  // §2.8 gate is type-blind here, so the op must refuse rather than corrupt silently.
  const p = await project({
    'tsconfig.json': TSCONFIG,
    'src/api.ts':
      'export const f = (a?: number, b?: number, c?: number): number => (a ?? 0) + (b ?? 0) + (c ?? 0);\n',
    'src/use.ts': "import { f } from './api';\nexport const r = f(1, 2);\n", // omits c
  });
  try {
    const [r] = await p.request([
      { name: 'change_signature', args: { name: 'f', reorder: [2, 1, 0] }, apply: true },
    ]);
    assert.ok(
      r !== undefined && 'result' in r && !r.result.ok,
      'under-supplied reorder must refuse',
    );
    if ('result' in r && !r.result.ok)
      assert.match(r.result.failure.message, /omits trailing arguments|cannot safely/);
    assert.equal(p.git('status', '--porcelain'), '');
  } finally {
    await p.dispose();
  }
});

test('change_signature: REFUSED when the symbol is used as a value (not just called)', async () => {
  const p = await project({
    'tsconfig.json': TSCONFIG,
    'src/api.ts': 'export const greet = (name: string, n: number): string => name + n;\n',
    'src/use.ts':
      "import { greet } from './api';\nconst g = greet;\nexport const a = g('hi', 3);\n", // value-use
  });
  try {
    const [r] = await p.request([
      { name: 'change_signature', args: { name: 'greet', reorder: [1, 0] }, apply: true },
    ]);
    assert.ok(r !== undefined && 'result' in r && !r.result.ok, 'value-use must refuse');
    if ('result' in r && !r.result.ok)
      assert.match(r.result.failure.message, /non-call use|cannot safely/);
    assert.equal(p.git('status', '--porcelain'), '');
  } finally {
    await p.dispose();
  }
});

test('change_signature: reorder is REFUSED when a call over-supplies args (rest param)', async () => {
  const p = await project({
    'tsconfig.json': TSCONFIG,
    'src/api.ts': 'export const f = (a: number, ...rest: number[]): number => a + rest.length;\n',
    'src/use.ts': "import { f } from './api';\nexport const r = f(1, 2, 3);\n", // 3 args, 2 params
  });
  try {
    const [r] = await p.request([
      { name: 'change_signature', args: { name: 'f', reorder: [1, 0] }, apply: true },
    ]);
    assert.ok(
      r !== undefined && 'result' in r && !r.result.ok,
      'over-supplied reorder must refuse',
    );
    if ('result' in r && !r.result.ok)
      assert.match(r.result.failure.message, /argument count|cannot safely/);
    assert.equal(p.git('status', '--porcelain'), '');
  } finally {
    await p.dispose();
  }
});

test('change_signature: removeParam is REFUSED on a method with a `this` parameter (index shift)', async () => {
  // `this` is declaration slot 0 but has no argument slot, so applying the decl-index drop to
  // call args silently binds the wrong argument. Both args are `string` → the §2.8 gate is
  // blind. Must refuse (the reorder count-guard never covered the removeParam path).
  const p = await project({
    'tsconfig.json': TSCONFIG,
    'src/api.ts':
      'export class Box {\n  paint(this: Box, a: string, b: string): string {\n    return a + b;\n  }\n}\n',
    'src/use.ts':
      "import { Box } from './api';\nconst box = new Box();\nexport const r = box.paint('A', 'B');\n",
  });
  try {
    const [r] = await p.request([
      { name: 'change_signature', args: { name: 'paint', removeParam: 1 }, apply: true },
    ]);
    assert.ok(
      r !== undefined && 'result' in r && !r.result.ok,
      'this-param removeParam must refuse, not silently mis-bind',
    );
    if ('result' in r && !r.result.ok) assert.match(r.result.failure.message, /this|cannot safely/);
    assert.equal(p.git('status', '--porcelain'), '');
  } finally {
    await p.dispose();
  }
});

test('change_signature: removeParam is REFUSED on a function with a rest parameter', async () => {
  // A rest parameter spans an unknown number of args; dropping by declaration index silently
  // drops trailing rest arguments (`f("x", 1, 2)` → `f(1)`). Same-typed → gate-blind. Refuse.
  const p = await project({
    'tsconfig.json': TSCONFIG,
    'src/api.ts': 'export const f = (a: string, ...rest: number[]): number => rest.length;\n',
    'src/use.ts': "import { f } from './api';\nexport const r = f('x', 1, 2);\n",
  });
  try {
    const [r] = await p.request([
      { name: 'change_signature', args: { name: 'f', removeParam: 0 }, apply: true },
    ]);
    assert.ok(
      r !== undefined && 'result' in r && !r.result.ok,
      'rest-param removeParam must refuse',
    );
    if ('result' in r && !r.result.ok)
      assert.match(r.result.failure.message, /rest parameter|cannot safely/);
    assert.equal(p.git('status', '--porcelain'), '');
  } finally {
    await p.dispose();
  }
});

test('change_signature: an overloaded function is REFUSED (single-signature only)', async () => {
  // Editing one overload signature (or the impl) leaves the other signatures + every call site
  // mismatched against their union — a same-typed mis-bind the §2.8 gate can miss. Refuse with
  // a clear reason (targeting the first signature via file:line:col to avoid name-ambiguity).
  const p = await project({
    'tsconfig.json': TSCONFIG,
    'src/api.ts':
      'export function f(a: string): string;\nexport function f(a: number): number;\nexport function f(a: number | string): string {\n  return String(a);\n}\n',
    'src/use.ts': "import { f } from './api';\nexport const r = f('x');\n",
  });
  try {
    const [r] = await p.request([
      {
        name: 'change_signature',
        args: { file: 'src/api.ts', line: 1, col: 17, removeParam: 0 },
        apply: true,
      },
    ]);
    assert.ok(r !== undefined && 'result' in r && !r.result.ok, 'overloaded fn must refuse');
    if ('result' in r && !r.result.ok)
      assert.match(r.result.failure.message, /overload|cannot safely/);
    assert.equal(p.git('status', '--porcelain'), '');
  } finally {
    await p.dispose();
  }
});

test('change_signature: an invalid reorder (not a permutation) fails honestly', async () => {
  const p = await project({
    'tsconfig.json': TSCONFIG,
    'src/api.ts': 'export const greet = (a: number, b: number): number => a + b;\n',
  });
  try {
    const [r] = await p.request([
      { name: 'change_signature', args: { name: 'greet', reorder: [0, 0] }, apply: true },
    ]);
    assert.ok(r !== undefined && 'result' in r && !r.result.ok, 'non-permutation must fail');
    if ('result' in r && !r.result.ok) assert.match(r.result.failure.message, /permutation/);
  } finally {
    await p.dispose();
  }
});
