// Consecutive `move_file` steps of a `transaction` are planned as ONE run on one tree (one import
// rewrite + capture pass). Oracle: the same moves applied one at a time through the STANDALONE
// `move_file` op (each committed before the next) must leave a byte-identical tree, and a cold
// `ts.Program` over the transaction's result must compile clean. A refusal inside a run must name
// the step at fault and write nothing.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { coldDiagnostics } from '../helpers/cold-ls.ts';
import type { JsonValue } from '../../src/core/json.ts';
import { project, type TestProject } from '../helpers/project.ts';

const FILES: Record<string, string> = {
  'tsconfig.json': '{"compilerOptions":{"strict":true,"module":"preserve"}}',
  'src/util.ts': 'export const twice = (n: number): number => n * 2;\n',
  'src/a/Button.ts':
    "import { twice } from '../util';\nexport const button = (n: number): number => twice(n);\n",
  'src/a/Button.module.scss': '.root { color: red; }\n',
  'src/app.ts':
    "import { button } from './a/Button';\nimport { twice } from './util';\nexport const app = button(twice(1));\n",
};

const MOVES = [
  { source: 'src/a/Button.ts', dest: 'src/b/Button.ts' },
  { source: 'src/util.ts', dest: 'src/lib/util.ts' },
  // The same file again — its `.module.scss` neighbour already travelled with the first move.
  { source: 'src/b/Button.ts', dest: 'src/c/Btn.ts' },
];

const moveSteps = (moves: readonly { source: string; dest: string }[]): JsonValue =>
  moves.map((m) => ({ name: 'move_file', args: { source: m.source, dest: m.dest } }));

async function txn(
  p: TestProject,
  steps: JsonValue,
  apply: boolean,
): Promise<{ ok: true; data: Record<string, JsonValue> } | { ok: false; message: string }> {
  const [r] = await p.request([
    { name: 'transaction', args: { steps }, ...(apply ? { apply: true } : {}) },
  ]);
  if (r === undefined || 'error' in r) assert.fail(`dispatch error: ${JSON.stringify(r)}`);
  if (!r.result.ok) return { ok: false, message: r.result.failure.message };
  return { ok: true, data: r.result.data as Record<string, JsonValue> };
}

function snapshot(p: TestProject): Map<string, string> {
  const files = p.git('ls-files').split('\n').filter(Boolean).sort();
  return new Map(files.map((f) => [f, readFileSync(path.join(p.root, f), 'utf8')]));
}

test('transaction: a run of move_file steps equals the same moves applied one by one', async () => {
  const run = await project(FILES);
  const oneByOne = await project(FILES);
  try {
    const applied = await txn(run, moveSteps(MOVES), true);
    assert.ok(applied.ok, `transaction failed: ${JSON.stringify(applied)}`);
    assert.equal(applied.data['applied'], true, JSON.stringify(applied.data));
    run.commit('txn');

    for (const m of MOVES) {
      const [r] = await oneByOne.request([
        { name: 'move_file', args: { source: m.source, dest: m.dest }, apply: true },
      ]);
      if (r === undefined || 'error' in r || !r.result.ok) assert.fail(JSON.stringify(r));
      assert.equal((r.result.data as Record<string, JsonValue>)['applied'], true);
      oneByOne.commit(`move ${m.source}`);
    }

    assert.deepEqual(snapshot(run), snapshot(oneByOne));
    assert.ok(snapshot(run).has('src/c/Btn.module.scss'), 'scss sibling followed BOTH moves');
    assert.deepEqual(coldDiagnostics(run.root), []);
  } finally {
    await run.dispose();
    await oneByOne.dispose();
  }
});

test('transaction: move run, rename, move run — the rename splits the run and the chain applies clean', async () => {
  const p = await project(FILES);
  try {
    const r = await txn(
      p,
      [
        { name: 'move_file', args: { source: 'src/util.ts', dest: 'src/lib/util.ts' } },
        { name: 'rename_symbol', args: { name: 'twice', newName: 'double' } },
        { name: 'move_file', args: { source: 'src/a/Button.ts', dest: 'src/ui/Button.ts' } },
      ],
      true,
    );
    assert.ok(r.ok, JSON.stringify(r));
    assert.equal(r.data['applied'], true, JSON.stringify(r.data));
    assert.deepEqual(coldDiagnostics(p.root), []);
    const btn = readFileSync(path.join(p.root, 'src/ui/Button.ts'), 'utf8');
    assert.match(btn, /import \{ double \} from ['"]\.\.\/lib\/util['"]/);
  } finally {
    await p.dispose();
  }
});

test('transaction: a refusal inside a move run names the step at fault and writes nothing', async () => {
  const p = await project({ ...FILES, 'src/taken.ts': 'export const t = 1;\n' });
  try {
    const occupied = await txn(
      p,
      moveSteps([
        { source: 'src/util.ts', dest: 'src/lib/util.ts' },
        { source: 'src/app.ts', dest: 'src/taken.ts' },
        { source: 'src/a/Button.ts', dest: 'src/b/Button.ts' },
      ]),
      true,
    );
    assert.ok(!occupied.ok);
    assert.match(
      occupied.message,
      /^step 1 'move_file' could not be planned: destination already exists/,
    );

    const refill = await txn(
      p,
      moveSteps([
        { source: 'src/util.ts', dest: 'src/lib/util.ts' },
        { source: 'src/app.ts', dest: 'src/util.ts' },
      ]),
      true,
    );
    assert.ok(!refill.ok);
    assert.match(refill.message, /^step 1 'move_file' could not be planned: .*vacated/);
    assert.equal(p.git('status', '--porcelain'), '');
  } finally {
    await p.dispose();
  }
});
