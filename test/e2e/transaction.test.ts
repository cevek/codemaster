// Stage E edit-safety oracle for `transaction` (§16.4, spec-transactional-mutation): an ORDERED
// chain of mutating ops applied atomically. Oracle: a cold `ts.Program` compile of the post-op
// tree (a wrong/missed rewrite surfaces as a real type error), `git status --porcelain` for
// byte-exact rollback, and diff(dry-run) == diff(apply). The chain is never half-applied.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import * as path from 'node:path';
import { coldDiagnostics as coldTscErrors } from '../helpers/cold-ls.ts';
import type { JsonValue } from '../../src/core/json.ts';
import { project, type TestProject } from '../helpers/project.ts';

const TSCONFIG = '{"compilerOptions":{"strict":true,"module":"preserve"}}';
type Proj = TestProject;

type Envelope = {
  mode: string;
  diff: string;
  typecheck: { clean: boolean };
  applied?: boolean;
  captures?: JsonValue;
  reason?: string;
};

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

const read = (p: Proj, rel: string): string => readFileSync(path.join(p.root, rel), 'utf8');

test('transaction: rename → move → change_signature applies atomically with ONE clean gate', async () => {
  const p = await project({
    'tsconfig.json': TSCONFIG,
    'src/api.ts': 'export const greet = (name: string, n: number): string => name + n;\n',
    'src/use.ts': "import { greet } from './api';\nexport const a = greet('hi', 3);\n",
  });
  try {
    const steps = [
      { name: 'rename_symbol', args: { name: 'greet', newName: 'hello' } },
      { name: 'move_file', args: { source: 'src/api.ts', dest: 'src/lib/api.ts' } },
      { name: 'change_signature', args: { name: 'hello', reorder: [1, 0] } },
    ];
    const dry = await txn(p, steps);
    assert.ok(dry.ok, `dry-run failed: ${JSON.stringify(dry)}`);
    assert.equal(dry.env.mode, 'dry-run');
    assert.equal(dry.env.typecheck.clean, true);
    assert.equal(p.git('status', '--porcelain'), ''); // dry-run wrote nothing

    const applied = await txn(p, steps, true);
    assert.ok(applied.ok, `apply failed: ${JSON.stringify(applied)}`);
    assert.equal(applied.env.applied, true);
    assert.equal(applied.env.typecheck.clean, true);
    assert.equal(applied.env.diff, dry.env.diff, 'diff(dry-run) === diff(apply)');

    // Independent oracle: the cold ts.Program over the post-op tree compiles clean.
    assert.deepEqual(coldTscErrors(p.root), []);
    assert.ok(!existsSync(path.join(p.root, 'src/api.ts')), 'source file moved away');
    assert.match(read(p, 'src/lib/api.ts'), /hello = \(n: number, name: string\)/);
    assert.match(read(p, 'src/use.ts'), /import \{ hello \} from ['"]\.\/lib\/api['"]/);
    assert.match(read(p, 'src/use.ts'), /hello\(3, ['"]hi['"]\)/);
  } finally {
    await p.dispose();
  }
});

test('transaction: a LAST step that introduces an error rolls back the WHOLE sequence byte-exact', async () => {
  const p = await project({
    'tsconfig.json': TSCONFIG,
    // `loud` is USED in the body → removing it cannot compile (the gate catches it at the end).
    'src/api.ts': 'export const greet = (name: string, loud: boolean): string => name + loud;\n',
    'src/use.ts': "import { greet } from './api';\nexport const a = greet('hi', true);\n",
  });
  try {
    const before = p.git('rev-parse', 'HEAD');
    const r = await txn(
      p,
      [
        { name: 'rename_symbol', args: { name: 'greet', newName: 'hello' } },
        { name: 'move_file', args: { source: 'src/api.ts', dest: 'src/lib/api.ts' } },
        { name: 'change_signature', args: { name: 'hello', removeParam: 1 } },
      ],
      true,
    );
    assert.ok(r.ok, `expected an applied-but-rolled-back envelope: ${JSON.stringify(r)}`);
    assert.equal(r.env.applied, false); // refused: the cumulative gate is unclean
    assert.equal(r.env.typecheck.clean, false);
    // Byte-exact rollback of the WHOLE sequence: nothing moved, nothing edited, index clean.
    assert.equal(p.git('status', '--porcelain'), '');
    assert.equal(p.git('rev-parse', 'HEAD'), before);
    assert.ok(existsSync(path.join(p.root, 'src/api.ts')), 'rolled back: source file restored');
    assert.ok(!existsSync(path.join(p.root, 'src/lib/api.ts')), 'rolled back: move target removed');
    assert.deepEqual(coldTscErrors(p.root), []); // the original tree still compiles
  } finally {
    await p.dispose();
  }
});

test('transaction: a MIDDLE step that cannot be planned refuses with the step index, writes nothing', async () => {
  const p = await project({
    'tsconfig.json': TSCONFIG,
    'src/api.ts': 'export const greet = (name: string, n: number): string => name + n;\n',
    'src/use.ts': "import { greet } from './api';\nexport const a = greet('hi', 3);\n",
  });
  try {
    const r = await txn(
      p,
      [
        { name: 'rename_symbol', args: { name: 'greet', newName: 'hello' } },
        { name: 'move_file', args: { source: 'src/does-not-exist.ts', dest: 'src/x.ts' } },
        { name: 'change_signature', args: { name: 'hello', reorder: [1, 0] } },
      ],
      true,
    );
    assert.ok(!r.ok, 'an unplannable middle step must refuse the whole transaction');
    assert.match(r.message, /step 1/);
    assert.match(r.message, /does-not-exist|could not be planned/);
    assert.equal(p.git('status', '--porcelain'), ''); // no prefix applied
  } finally {
    await p.dispose();
  }
});

test('transaction: a chain whose step would CAPTURE an in-scope binding is REFUSED (Task A)', async () => {
  const p = await project({
    'tsconfig.json': TSCONFIG,
    // Renaming `slugify` → `upper` makes `slugify(x)` re-bind to the existing `upper` (a
    // type-compatible silent capture the §2.8 typecheck cannot see).
    'src/a.ts':
      'export const upper = (s: string): string => s.toUpperCase();\n' +
      'export const slugify = (s: string): string => s + "-slug";\n' +
      'export const use = (x: string): string => slugify(x);\n',
  });
  try {
    const r = await txn(
      p,
      [
        { name: 'rename_symbol', args: { name: 'use', newName: 'use2' } },
        { name: 'rename_symbol', args: { name: 'slugify', newName: 'upper' } },
      ],
      true,
    );
    assert.ok(r.ok, `capture surfaces on the envelope (not a hard fail): ${JSON.stringify(r)}`);
    assert.equal(r.env.applied, false);
    assert.ok(r.env.captures !== undefined, 'capture sites are listed');
    assert.equal(p.git('status', '--porcelain'), ''); // nothing written
  } finally {
    await p.dispose();
  }
});

test('transaction: a single-step chain is identical to the direct op (diff + verdict)', async () => {
  const fixture = {
    'tsconfig.json': TSCONFIG,
    'src/api.ts': 'export const greet = (name: string, n: number): string => name + n;\n',
    'src/use.ts': "import { greet } from './api';\nexport const a = greet('hi', 3);\n",
  };
  const p = await project(fixture);
  try {
    const [direct] = await p.request([
      { name: 'change_signature', args: { name: 'greet', reorder: [1, 0] } },
    ]);
    assert.ok(
      direct !== undefined && 'result' in direct && direct.result.ok,
      JSON.stringify(direct),
    );
    const directEnv = direct.result.data as unknown as Envelope;

    const single = await txn(p, [
      { name: 'change_signature', args: { name: 'greet', reorder: [1, 0] } },
    ]);
    assert.ok(single.ok, JSON.stringify(single));
    assert.equal(single.env.typecheck.clean, directEnv.typecheck.clean);
    assert.equal(single.env.diff, directEnv.diff, 'single-step transaction diff == direct op diff');
  } finally {
    await p.dispose();
  }
});

test('transaction: a step-≥2 rename plans against the prior move overlay (nested overlay), applies clean', async () => {
  // The capture detector for step 2 runs while step 1's MOVE overlay is active. A flat overlay
  // wipe would revert the moved-away source to disk (resolving references against the wrong tree);
  // the nest-safe overlay keeps the move's tombstone, so the rename composes + cold-compiles.
  const p = await project({
    'tsconfig.json': TSCONFIG,
    'src/api.ts': 'export const greet = (n: number): number => n;\n',
    'src/use.ts': "import { greet } from './api';\nexport const a = (): number => greet(1);\n",
  });
  try {
    const r = await txn(
      p,
      [
        { name: 'move_file', args: { source: 'src/api.ts', dest: 'src/lib/api.ts' } },
        { name: 'rename_symbol', args: { name: 'greet', newName: 'hello' } },
      ],
      true,
    );
    assert.ok(r.ok && r.env.applied === true, `expected clean apply: ${JSON.stringify(r)}`);
    assert.equal(r.env.typecheck.clean, true);
    assert.deepEqual(coldTscErrors(p.root), []);
    assert.match(read(p, 'src/lib/api.ts'), /export const hello/);
    assert.match(read(p, 'src/use.ts'), /import \{ hello \} from ['"]\.\/lib\/api['"]/);
  } finally {
    await p.dispose();
  }
});

test('transaction: step-2 rename capture detection resolves through a prior step move (DISCRIMINATES the nested-overlay fix)', async () => {
  // b.ts reaches `fn` through a re-export barrel. Step 1 MOVES the barrel; step 2 renames `fn`.
  // The rename's capture detector must resolve b.ts's reference THROUGH the moved barrel — which
  // only works if its overlay STACKS on step 1's move (tombstone of the old barrel path + new
  // path). A flat overlay wipe drops the move, the barrel import dangles, b.ts's site vanishes from
  // the reference set, and a FORWARD capture is FABRICATED → false refusal. The fix → clean apply.
  const p = await project({
    'tsconfig.json': TSCONFIG,
    'src/a.ts': 'export const fn = (n: number): number => n;\n',
    'src/barrel.ts': "export * from './a';\n",
    'src/use.ts': "import { fn } from './barrel';\nexport const u = (): number => fn(1);\n",
  });
  try {
    const r = await txn(
      p,
      [
        { name: 'move_file', args: { source: 'src/barrel.ts', dest: 'src/sub/barrel.ts' } },
        { name: 'rename_symbol', args: { name: 'fn', newName: 'gn' } },
      ],
      true,
    );
    assert.ok(r.ok && r.env.applied === true, `expected clean apply, got: ${JSON.stringify(r)}`);
    assert.equal(r.env.captures, undefined, 'no capture should be fabricated');
    assert.deepEqual(coldTscErrors(p.root), []);
    assert.match(read(p, 'src/a.ts'), /export const gn/);
    assert.match(read(p, 'src/use.ts'), /import \{ gn \} from ['"]\.\/sub\/barrel['"]/);
  } finally {
    await p.dispose();
  }
});

test('transaction: re-occupying a path a prior step vacated by a move is REFUSED (no silent move-drop)', async () => {
  const p = await project({
    'tsconfig.json': TSCONFIG,
    'src/a.ts':
      'export const helper = (n: number): number => n;\nexport const beta = (): number => 2;\n',
    'src/use.ts': "import { beta } from './a';\nexport const u = (): number => beta();\n",
  });
  try {
    // move a.ts → b.ts, then extract a symbol whose dest is the vacated a.ts — not representable.
    const r = await txn(
      p,
      [
        { name: 'move_file', args: { source: 'src/a.ts', dest: 'src/b.ts' } },
        { name: 'extract_symbol', args: { name: 'helper', dest: 'src/a.ts' } },
      ],
      true,
    );
    assert.ok(!r.ok, 'must refuse rather than silently drop the move');
    assert.match(r.message, /vacated|not representable|step 1/);
    assert.equal(p.git('status', '--porcelain'), '');
  } finally {
    await p.dispose();
  }
});

test('transaction: refuse branches write nothing (unknown step · invalid args · no-op chain)', async () => {
  const p = await project({
    'tsconfig.json': TSCONFIG,
    'src/api.ts': 'export const greet = (name: string, n: number): string => name + n;\n',
  });
  try {
    const unknown = await txn(p, [{ name: 'reformat_universe', args: {} }], true);
    assert.ok(!unknown.ok && /not a supported transaction step/.test(unknown.message));
    assert.match(unknown.message, /step 0/);

    const badArgs = await txn(p, [{ name: 'rename_symbol', args: { name: 'greet' } }], true);
    assert.ok(!badArgs.ok && /invalid args/.test(badArgs.message), JSON.stringify(badArgs));
    assert.match(badArgs.message, /step 0/);

    // A rename to the SAME name produces no edits → an honest "nothing to apply", not a false write.
    const noop = await txn(
      p,
      [{ name: 'rename_symbol', args: { name: 'greet', newName: 'greet' } }],
      true,
    );
    assert.ok(!noop.ok, JSON.stringify(noop));

    assert.equal(p.git('status', '--porcelain'), ''); // every refuse branch wrote nothing
  } finally {
    await p.dispose();
  }
});
