// Stage E edit-safety oracle for `move_symbol` as a `transaction` step (§16.4,
// spec-transactional-mutation). Three independent oracles, none golden:
//   IDENTITY — a single-step `transaction` move_symbol is byte-exact equal to the standalone
//     `move_symbol` op (guards the signature change: `planTree(undefined)` ≡ `loadTreeFromGit`).
//   OVERLAY-AWARENESS (discriminating) — a `rename foo→bar` THEN `move_symbol name:'bar'` chain
//     can only resolve `bar` if step 2 plans against step 1's overlay, not pre-transaction disk. A
//     test that moved an UNTOUCHED symbol would pass even with the overlay wiring broken — this one
//     fails. Oracle: a cold `ts.Program` compile of the post-op tree.
//   ROLLBACK — a later step's unclean gate rolls the move_symbol edits back byte-exact (git porcelain).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
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

test('move_symbol: a single-step transaction is byte-exact identical to the direct op', async () => {
  // IDENTITY: the standalone op plans via `loadTreeFromGit`; the single-step transaction plans via
  // `planTree(undefined)` — the SAME call. The diffs (and verdict) must match byte-for-byte, or the
  // overlay-threading signature change silently drifted the standalone path.
  const fixture = {
    'tsconfig.json': TSCONFIG,
    'src/source.ts':
      'export const helper = (x: number): number => x * 2;\n' +
      'export const other = (): number => helper(1);\n',
    'src/dest.ts': 'export const existing = 1;\n',
    'src/consumer.ts':
      "import { helper } from './source';\nexport const use = (): number => helper(2);\n",
  };
  const p = await project(fixture);
  try {
    const [direct] = await p.request([
      { name: 'move_symbol', args: { name: 'helper', dest: 'src/dest.ts' } },
    ]);
    assert.ok(
      direct !== undefined && 'result' in direct && direct.result.ok,
      JSON.stringify(direct),
    );
    const directEnv = direct.result.data as unknown as Envelope;

    const single = await txn(p, [
      { name: 'move_symbol', args: { name: 'helper', dest: 'src/dest.ts' } },
    ]);
    assert.ok(single.ok, JSON.stringify(single));
    assert.equal(single.env.typecheck.clean, directEnv.typecheck.clean);
    assert.equal(single.env.diff, directEnv.diff, 'single-step transaction diff == direct op diff');
    assert.equal(p.git('status', '--porcelain'), ''); // both were dry-run — nothing written
  } finally {
    await p.dispose();
  }
});

test('move_symbol: a step-≥2 move plans against a prior rename overlay (DISCRIMINATING), applies clean', async () => {
  // `bar` exists only AFTER step 1's rename. If `move_symbol` planned against pre-transaction disk
  // it would resolve `name:'bar'` to nothing and the step would refuse — so a clean apply PROVES the
  // overlay reaches the move's target resolution + plan. Edit-safety (§16.4) asserted alongside:
  // dry-run leaves git clean, diff(dry-run) == diff(apply), and a cold compile is clean post-apply.
  const fixture = {
    'tsconfig.json': TSCONFIG,
    'src/source.ts': 'export const foo = (x: number): number => x * 2;\n',
    'src/dest.ts': 'export const existing = 1;\n',
    'src/consumer.ts':
      "import { foo } from './source';\nexport const use = (): number => foo(2);\n",
  };
  const steps = [
    { name: 'rename_symbol', args: { name: 'foo', newName: 'bar' } },
    { name: 'move_symbol', args: { name: 'bar', dest: 'src/dest.ts' } },
  ];
  const p = await project(fixture);
  try {
    const dry = await txn(p, steps);
    assert.ok(dry.ok, `dry-run failed — overlay wiring broken? ${JSON.stringify(dry)}`);
    assert.equal(dry.env.mode, 'dry-run');
    assert.equal(dry.env.typecheck.clean, true, JSON.stringify(dry.env));
    assert.equal(p.git('status', '--porcelain'), ''); // dry-run wrote nothing

    const applied = await txn(p, steps, true);
    assert.ok(
      applied.ok && applied.env.applied === true,
      `apply failed: ${JSON.stringify(applied)}`,
    );
    assert.equal(applied.env.typecheck.clean, true);
    assert.equal(applied.env.diff, dry.env.diff, 'diff(dry-run) === diff(apply)');

    // Independent oracle: the cold ts.Program over the post-op tree compiles clean (no new errors).
    assert.deepEqual(coldTscErrors(p.root), []);
    assert.match(read(p, 'src/dest.ts'), /export const bar/, 'renamed symbol landed in dest');
    assert.doesNotMatch(read(p, 'src/source.ts'), /export const (foo|bar)/, 'symbol left source');
    // The aliased importer was renamed (step 1) then repointed to dest (step 2) — both overlay-composed.
    assert.match(read(p, 'src/consumer.ts'), /import \{ bar \} from ['"]\.\/dest['"]/);
    assert.match(read(p, 'src/consumer.ts'), /bar\(2\)/);
  } finally {
    await p.dispose();
  }
});

test('move_symbol: a step whose chain ends unclean rolls the move back byte-exact', async () => {
  // The move_symbol edits must participate in the all-or-nothing rollback: a trailing
  // change_signature that drops a USED parameter makes the cumulative gate unclean → the WHOLE
  // sequence (including the move) reverts byte-exact. Oracle: git porcelain + HEAD unchanged.
  const p = await project({
    'tsconfig.json': TSCONFIG,
    // `loud` is used in the body → removing it cannot compile; the cumulative gate catches it.
    'src/source.ts': 'export const greet = (name: string, loud: boolean): string => name + loud;\n',
    'src/dest.ts': 'export const existing = 1;\n',
    'src/use.ts': "import { greet } from './source';\nexport const a = greet('hi', true);\n",
  });
  try {
    const before = p.git('rev-parse', 'HEAD');
    const r = await txn(
      p,
      [
        { name: 'move_symbol', args: { name: 'greet', dest: 'src/dest.ts' } },
        { name: 'change_signature', args: { name: 'greet', removeParam: 1 } },
      ],
      true,
    );
    assert.ok(r.ok, `expected an applied-but-rolled-back envelope: ${JSON.stringify(r)}`);
    assert.notEqual(r.env.applied, true); // refused: the cumulative gate is unclean
    assert.equal(r.env.typecheck.clean, false);
    // Byte-exact rollback of the WHOLE sequence — the move is fully reverted.
    assert.equal(p.git('status', '--porcelain'), '');
    assert.equal(p.git('rev-parse', 'HEAD'), before);
    assert.match(
      read(p, 'src/source.ts'),
      /export const greet/,
      'move rolled back: symbol restored',
    );
    assert.doesNotMatch(read(p, 'src/dest.ts'), /greet/, 'move rolled back: dest untouched');
    assert.deepEqual(coldTscErrors(p.root), []); // the original tree still compiles
  } finally {
    await p.dispose();
  }
});
