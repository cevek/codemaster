// Wall-clock deadline wired into the MUTATING ops (t-072590). A refactoring's expensive phase is
// the COMPUTE (reference search + the §2.8 typecheck gate), all BEFORE the atomic write (§7). So
// an exhausted budget must degrade to an honest `ToolFailure{tool:'timeout'}` with ZERO files
// written — the never-HANG gap the reads already close, now closed for writes too, WITHOUT ever
// breaking never-CORRUPT.
//
// Two honesty properties per op, each with an independent oracle:
//   (a) generous budget → apply succeeds and the tree changes (the deadline never trips —
//       behaviour byte-identical to before). Oracle: git porcelain shows the write.
//   (b) exhausted budget (opDeadlineMs:0, already expired under the frozen manual clock) →
//       a `timeout` failure AND the git tree is CLEAN — the abort landed before the write.
//       Oracle: `git status --porcelain` is empty; the committed bytes are untouched.
// No sleep — the 0-budget is deterministically expired (§16).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { project } from '../helpers/project.ts';
import type { JsonValue } from '../../src/core/json.ts';
import type { OpRequest } from '../../src/ops/contracts.ts';
import type { Result } from '../../src/core/result.ts';

type Proj = Awaited<ReturnType<typeof project>>;

/** Drive one mutating request (apply) and return the Result envelope, failing on a dispatch error. */
async function apply(p: Proj, req: OpRequest): Promise<Result<JsonValue>> {
  const [r] = await p.request([{ ...req, apply: true }]);
  if (r === undefined || 'error' in r) assert.fail(`dispatch error: ${JSON.stringify(r)}`);
  return r.result as Result<JsonValue>;
}

/** The never-corrupt oracle: an exhausted-budget apply is a `timeout` failure AND wrote nothing. */
function assertTimeoutNoWrite(p: Proj, res: Result<JsonValue>): void {
  assert.equal(res.ok, false, 'a failure envelope, never a silent partial apply');
  assert.ok(!res.ok && res.failure.tool === 'timeout', `tool=timeout, got ${JSON.stringify(res)}`);
  assert.ok(
    !res.ok && res.failure.partial !== true,
    'NOT partial — a compute timeout wrote nothing',
  );
  assert.equal(
    p.git('status', '--porcelain'),
    '',
    'git tree CLEAN — abort landed before the write',
  );
}

const RENAME_FIXTURE = {
  'tsconfig.json': '{"compilerOptions":{"strict":true}}',
  'src/def.ts': 'export const widget = 1;\n',
  'src/a.ts': "import { widget } from './def';\nexport const a = widget + 1;\n",
  'src/b.ts': "import { widget } from './def';\nexport const b = widget + 2;\n",
};

test('rename_symbol (applyMutation): generous budget applies and rewrites every site', async () => {
  const p = await project(RENAME_FIXTURE);
  try {
    const res = await apply(p, {
      name: 'rename_symbol',
      args: { name: 'widget', newName: 'gadget' },
    });
    assert.ok(res.ok, `expected ok, got ${JSON.stringify(res)}`);
    const def = readFileSync(path.join(p.root, 'src/def.ts'), 'utf8');
    assert.ok(def.includes('gadget'), 'the declaration was renamed on disk');
  } finally {
    await p.dispose();
  }
});

test('rename_symbol: exhausted budget → timeout BEFORE the write, git tree clean', async () => {
  const p = await project(RENAME_FIXTURE, { opDeadlineMs: 0 });
  try {
    const before = readFileSync(path.join(p.root, 'src/def.ts'), 'utf8');
    const res = await apply(p, {
      name: 'rename_symbol',
      args: { name: 'widget', newName: 'gadget' },
    });
    assertTimeoutNoWrite(p, res);
    assert.equal(readFileSync(path.join(p.root, 'src/def.ts'), 'utf8'), before, 'bytes untouched');
  } finally {
    await p.dispose();
  }
});

const MOVE_FIXTURE = {
  'tsconfig.json': '{"compilerOptions":{"strict":true}}',
  'src/old.ts': 'export const thing = 42;\n',
  'src/use.ts': "import { thing } from './old';\nexport const use = thing + 1;\n",
};

test('move_file (applyRefactorPlan): generous budget applies and repoints importers', async () => {
  const p = await project(MOVE_FIXTURE);
  try {
    const res = await apply(p, {
      name: 'move_file',
      args: { source: 'src/old.ts', dest: 'src/new.ts' },
    });
    assert.ok(res.ok, `expected ok, got ${JSON.stringify(res)}`);
    const use = readFileSync(path.join(p.root, 'src/use.ts'), 'utf8');
    assert.ok(use.includes("'./new'"), 'importer repointed to the new path');
  } finally {
    await p.dispose();
  }
});

test('move_file: exhausted budget → timeout BEFORE the write, git tree clean', async () => {
  const p = await project(MOVE_FIXTURE, { opDeadlineMs: 0 });
  try {
    const res = await apply(p, {
      name: 'move_file',
      args: { source: 'src/old.ts', dest: 'src/new.ts' },
    });
    assertTimeoutNoWrite(p, res);
  } finally {
    await p.dispose();
  }
});

const EXTRACT_FIXTURE = {
  'tsconfig.json': '{"compilerOptions":{"strict":true}}',
  'src/main.ts':
    'export const helper = (x: number): number => x * 2;\nexport const main = (): number => helper(3);\n',
};

test('extract_symbol: exhausted budget → timeout BEFORE the write, git tree clean', async () => {
  const p = await project(EXTRACT_FIXTURE, { opDeadlineMs: 0 });
  try {
    const res = await apply(p, {
      name: 'extract_symbol',
      args: { name: 'helper', dest: 'src/lib.ts' },
    });
    assertTimeoutNoWrite(p, res);
  } finally {
    await p.dispose();
  }
});

const CHANGE_SIG_FIXTURE = {
  'tsconfig.json': '{"compilerOptions":{"strict":true}}',
  'src/greet.ts':
    'export const greet = (a: string, b: string): string => a + b;\nexport const call = (): string => greet("x", "y");\n',
};

test('change_signature: exhausted budget → timeout BEFORE the write, git tree clean', async () => {
  const p = await project(CHANGE_SIG_FIXTURE, { opDeadlineMs: 0 });
  try {
    const res = await apply(p, {
      name: 'change_signature',
      args: { name: 'greet', removeParam: 1 },
    });
    assertTimeoutNoWrite(p, res);
  } finally {
    await p.dispose();
  }
});

test('transaction: generous budget applies the whole chain', async () => {
  const p = await project(RENAME_FIXTURE);
  try {
    const res = await apply(p, {
      name: 'transaction',
      args: { steps: [{ name: 'rename_symbol', args: { name: 'widget', newName: 'gadget' } }] },
    });
    assert.ok(res.ok, `expected ok, got ${JSON.stringify(res)}`);
    assert.ok(readFileSync(path.join(p.root, 'src/def.ts'), 'utf8').includes('gadget'));
  } finally {
    await p.dispose();
  }
});

test('transaction: exhausted budget → timeout at the step boundary, git tree clean', async () => {
  const p = await project(RENAME_FIXTURE, { opDeadlineMs: 0 });
  try {
    const res = await apply(p, {
      name: 'transaction',
      args: { steps: [{ name: 'rename_symbol', args: { name: 'widget', newName: 'gadget' } }] },
    });
    assertTimeoutNoWrite(p, res);
  } finally {
    await p.dispose();
  }
});
