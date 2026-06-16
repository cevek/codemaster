// Cross-program symmetry for `transaction` (the multi-anchor write gate). A chain whose steps
// touch SEVERAL programs must not let a PRE-EXISTING error in one program be mis-counted as
// introduced by another — the per-program overlay/baseline sampling must stay symmetric, or a
// sound multi-move chain falsely rolls back (a §3.6 lie). Oracle: an independent cold compile of
// the disjoint sibling program (it must stay clean — the chain didn't break it).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import * as path from 'node:path';
import { coldDiagnostics } from '../helpers/cold-ls.ts';
import type { JsonValue } from '../../src/core/json.ts';
import { project, type TestProject } from '../helpers/project.ts';

type Envelope = { typecheck: { clean: boolean }; applied?: boolean };

async function txn(
  p: TestProject,
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

test('transaction: a multi-anchor chain does NOT mis-count a pre-existing error as introduced', async () => {
  // Two moves pull in TWO programs (primary + the disjoint `extra`). Two compounding traps:
  //  (1) the overlay force-adds every overlaid file to each affected program's script set — so a
  //      naive gate diagnoses the moved `src/a2.ts` (carrying a PRE-EXISTING error) under the
  //      `extra` program too → counted once in the baseline, twice in the overlay → a false
  //      "introduced" surplus. Each program must be overlaid ONLY with the files it owns.
  //  (2) the composed checkPaths must still sample the moved-away ORIGIN (`src/a.ts`) so the §1b
  //      path-remap can cancel the pre-existing error against its relocated copy.
  // With both closed, the chain APPLIES (the pre-existing error rides along, never blocks).
  const p = await project({
    'tsconfig.json': '{"compilerOptions":{"strict":true,"module":"preserve"},"include":["src"]}',
    'tsconfig.extra.json':
      '{"compilerOptions":{"strict":true,"module":"preserve"},"include":["extra"]}',
    'src/a.ts': "export const bad: number = 'not a number';\n", // PRE-EXISTING error, primary-owned
    'extra/b.ts': 'export const b = 1;\n', // clean, owned only by the disjoint extra program
  });
  try {
    const steps = [
      { name: 'move_file', args: { source: 'src/a.ts', dest: 'src/a2.ts' } },
      { name: 'move_file', args: { source: 'extra/b.ts', dest: 'extra/b2.ts' } },
    ];
    const dry = await txn(p, steps);
    assert.ok(dry.ok, `dry-run failed: ${JSON.stringify(dry)}`);
    assert.equal(
      dry.env.typecheck.clean,
      true,
      `the pre-existing error must NOT be counted as introduced: ${JSON.stringify(dry.env.typecheck)}`,
    );
    const applied = await txn(p, steps, true);
    assert.ok(applied.ok, `apply failed: ${JSON.stringify(applied)}`);
    assert.equal(applied.env.applied, true, JSON.stringify(applied.env));
    assert.ok(
      existsSync(path.join(p.root, 'src/a2.ts')) && existsSync(path.join(p.root, 'extra/b2.ts')),
      'both moves landed',
    );
    // Independent oracle: the disjoint sibling program compiles clean post-move — the chain did not
    // break it (the repo's only error is the pre-existing one, under the primary program).
    assert.deepEqual(
      coldDiagnostics(p.root, 'tsconfig.extra.json'),
      [],
      'the sibling program stays clean',
    );
  } finally {
    await p.dispose();
  }
});
