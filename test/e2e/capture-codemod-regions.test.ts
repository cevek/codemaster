// Region-arithmetic guards for codemod capture detection (§ capture-safety). The detector
// normalizes post-edit declaration offsets back to pre-edit space by accumulating the length delta
// of every earlier rewritten region in the file (`beforeOffsetMapper`). The multi-region
// accumulation (`acc = delta1 + delta2 + …`) is the offset-math hot spot — these tests force it in
// BOTH directions: a clean codemod with a preserved reference below TWO grown regions must NOT
// false-flag (over-refusal), and a genuine capture across the same two regions must still fire.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { coldDiagnostics as coldTscErrors } from '../helpers/cold-ls.ts';
import type { JsonValue } from '../../src/core/json.ts';
import { project } from '../helpers/project.ts';

const TSCONFIG = '{"compilerOptions":{"strict":true,"module":"preserve"}}';
type Proj = Awaited<ReturnType<typeof project>>;
type Envelope = { applied?: boolean; captures?: { kind: string }[] };

async function codemod(p: Proj, args: JsonValue, apply = false): Promise<Envelope> {
  const [r] = await p.request([{ name: 'codemod', args, ...(apply ? { apply: true } : {}) }]);
  if (r === undefined || 'error' in r) assert.fail(`dispatch error: ${JSON.stringify(r)}`);
  assert.ok(r.result.ok, `expected ok, got ${JSON.stringify(r)}`);
  return r.result.data as unknown as Envelope;
}

test('codemod OVER-REFUSAL guard: a preserved ref below TWO grown regions must NOT false-flag (multi-region acc)', async () => {
  // Two `wrap(impl)` matches, both grown to `wrapLonger(impl)`; `impl` is preserved in both and its
  // declaration sits BELOW both regions, so its post-edit offset shifts by delta1+delta2. The
  // reverse-map must accumulate both deltas to recover the pre-edit offset — an off-by-one here
  // fabricates a capture on a clean codemod.
  const p = await project({
    'tsconfig.json': TSCONFIG,
    'src/main.ts':
      'export const a = wrap(impl);\n' +
      'export const b = wrap(impl);\n' +
      'function impl(): number {\n  return 1;\n}\n' +
      'function wrap(n: () => number): number {\n  return n();\n}\n' +
      'function wrapLonger(n: () => number): number {\n  return n();\n}\n',
  });
  try {
    const ap = await codemod(p, { pattern: 'wrap($X)', rewrite: 'wrapLonger($X)' }, true);
    assert.equal(ap.captures, undefined, 'a preserved ref below two regions must NOT be flagged');
    assert.equal(ap.applied, true, 'the clean multi-region codemod must apply');
    assert.deepEqual(coldTscErrors(p.root), []);
  } finally {
    await p.dispose();
  }
});

test('codemod OVER-REFUSAL guard: a metavar bound to an IN-PATTERN local/decl must NOT false-flag', async () => {
  // The before/after key spaces must be symmetric: a metavar whose declaration lives INSIDE the
  // rewritten span in BOTH phases (here `const v`, authored by the pattern) must key `undefined`
  // both sides and collapse into the introduced-identifier skip — NOT key defined-before /
  // undefined-after, which fabricated a capture. `$E` (compute) resolves OUTSIDE the span and is
  // unchanged, so the codemod is clean.
  const p = await project({
    'tsconfig.json': TSCONFIG,
    'src/main.ts':
      'function compute(): number {\n  return 1;\n}\n' +
      'export const g = () => {\n  const v = compute();\n  return v;\n};\n',
  });
  try {
    const ap = await codemod(
      p,
      {
        pattern: '() => { const $V = $E; return $V; }',
        rewrite: '() => { const $V = $E; return [$V]; }',
      },
      true,
    );
    assert.equal(
      ap.captures,
      undefined,
      'a metavar bound to an in-pattern local must NOT be flagged',
    );
    assert.equal(ap.applied, true, 'the clean codemod must apply');
    assert.deepEqual(coldTscErrors(p.root), []);
  } finally {
    await p.dispose();
  }
});

test('codemod CAPTURE: a genuine capture in EACH of two regions still fires (multi-region acc, capture direction)', async () => {
  // Same two-region shape, but each rewrite shadows the preserved `tag` with a lambda param — both
  // sites are real captures. The accumulation must locate both windows correctly.
  const p = await project({
    'tsconfig.json': TSCONFIG,
    'src/a.ts': "export const tag: string = 'A';\n",
    'src/main.ts':
      "import { tag } from './a';\n" +
      'const identity = (s: string): string => s;\n' +
      'const pick = (cb: (tag: string) => string): string => cb("x");\n' +
      'export const r1 = identity(tag);\n' +
      'export const r2 = identity(tag);\n',
  });
  try {
    const dry = await codemod(p, { pattern: 'identity($X)', rewrite: 'pick((tag) => $X)' });
    assert.ok(
      dry.captures !== undefined && dry.captures.length >= 2,
      'both region captures must fire (got ' + JSON.stringify(dry.captures) + ')',
    );
  } finally {
    await p.dispose();
  }
});

test('codemod OVER-REFUSAL guard: non-ASCII before a region must NOT fabricate a capture (byte↔UTF-16)', async () => {
  // A non-ASCII identifier/string before the rewritten region desyncs ast-grep BYTE offsets from TS
  // UTF-16 char offsets; without the byte→UTF-16 convert the preserved `impl` reference below is
  // mis-bounded and a capture is FABRICATED on a clean codemod (the §1 over-refusal risk).
  const p = await project({
    'tsconfig.json': TSCONFIG,
    'src/main.ts':
      "export const café = '☕';\n" +
      'export const a = wrap(impl);\n' +
      'function impl(): number {\n  return 1;\n}\n' +
      'function wrap(n: () => number): number {\n  return n();\n}\n' +
      'function wrapLonger(n: () => number): number {\n  return n();\n}\n',
  });
  try {
    const ap = await codemod(p, { pattern: 'wrap($X)', rewrite: 'wrapLonger($X)' }, true);
    assert.equal(
      ap.captures,
      undefined,
      'non-ASCII before the region must NOT fabricate a capture',
    );
    assert.equal(ap.applied, true, 'the clean codemod must apply');
    assert.deepEqual(coldTscErrors(p.root), []);
  } finally {
    await p.dispose();
  }
});
