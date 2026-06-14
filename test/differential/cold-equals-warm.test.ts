// §16 invariant 3 — per-plugin `cold == warm`: for any state reached by a sequence of
// edits, the warm daemon's answer must equal a COLD-booted daemon's answer over the
// identical final tree. This is the net for incremental-update drift — each plugin patches
// its own state in place, and a patch that diverges from a clean rebuild is a silent lie.
//
// We compare the FACT arrays (the proof-carrying payload: spans + role + confidence),
// sorted — NOT the `Result` envelope. `freshness` (warm reindexed-at-entry vs cold-clean),
// `indexedAtCommit` (warm has 2 commits, cold has 1) and version-stamped SymbolIds differ
// by construction and are not facts about the code. Comparing the spans IS the point —
// invariant 1 (span validity) rides along, so a drifted span fails here too.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { project } from '../helpers/project.ts';
import type { OpResult } from '../../src/ops/contracts.ts';
import type { JsonValue } from '../../src/core/json.ts';

const TSCONFIG = '{"compilerOptions":{"strict":true,"jsx":"react-jsx"}}';

function factField(r: OpResult, key: 'usages' | 'classes'): JsonValue[] {
  assert.ok('result' in r && r.result.ok, JSON.stringify(r));
  const arr = (r.result.data as Record<string, JsonValue[]>)[key] ?? [];
  // Stable order: the warm/cold collection order is not part of the fact.
  return [...arr].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
}

test('cold == warm (ts): find_usages after an add equals a cold boot over the final tree', async () => {
  const initial = {
    'tsconfig.json': TSCONFIG,
    'src/util.ts': 'export const twice = (n: number): number => n * 2;\n',
    'src/a.ts': "import { twice } from './util.ts';\nexport const a = twice(1);\n",
  };
  const bContent = "import { twice } from './util.ts';\nexport const b = twice(2);\n";

  // Warm: boot without b.ts, run a BASELINE query (this pins the freshness guard's state
  // at the initial tree — without it the first op after the write sees `prev === undefined`
  // and the warm path collapses into a disguised cold boot, never exercising the
  // incremental reindex this invariant guards). Then ADD b.ts and query again — op#2 detects
  // the drift and patches the ts plugin in place.
  const warmP = await project(initial);
  let warm: JsonValue[];
  try {
    await warmP.op('find_usages', { name: 'twice', collapseImports: false });
    warmP.write('src/b.ts', bContent);
    const op2 = await warmP.op('find_usages', { name: 'twice', collapseImports: false });
    assert.ok('result' in op2 && op2.result.ok);
    assert.ok(
      (op2.result.freshness?.reindexed ?? 0) >= 1,
      'the warm path must reindex incrementally at op#2 — otherwise it is a disguised cold boot',
    );
    warm = factField(op2, 'usages');
  } finally {
    await warmP.dispose();
  }

  // Cold: boot over the identical FINAL tree (b.ts already present), query once.
  const coldP = await project({ ...initial, 'src/b.ts': bContent });
  let cold: JsonValue[];
  try {
    cold = factField(
      await coldP.op('find_usages', { name: 'twice', collapseImports: false }),
      'usages',
    );
  } finally {
    await coldP.dispose();
  }

  assert.deepEqual(warm, cold, 'an incrementally-patched ts plugin must match a cold rebuild');
  assert.ok(warm.length >= 3, 'sanity: decl + 2 call sites present');
});

test('cold == warm (scss): scss_classes after an in-place edit equals a cold boot', async () => {
  const initial = {
    'tsconfig.json': TSCONFIG,
    'src/a.module.scss': '.one { color: red; }\n',
    'src/use.ts': "import s from './a.module.scss';\nexport const x = s;\n",
  };
  const finalScss = '.one { color: red; }\n.two { color: blue; }\n';

  // Warm: boot with one class, BASELINE query (pins the guard state — see the ts case),
  // EDIT the file in place to add a second, query again so op#2 reindexes incrementally.
  const warmP = await project(initial);
  let warm: JsonValue[];
  try {
    await warmP.op('scss_classes', {});
    warmP.write('src/a.module.scss', finalScss);
    const op2 = await warmP.op('scss_classes', {});
    assert.ok('result' in op2 && op2.result.ok);
    assert.ok(
      (op2.result.freshness?.reindexed ?? 0) >= 1,
      'the warm path must reindex incrementally at op#2 — otherwise it is a disguised cold boot',
    );
    warm = factField(op2, 'classes');
  } finally {
    await warmP.dispose();
  }

  // Cold: boot over the final stylesheet, query once.
  const coldP = await project({ ...initial, 'src/a.module.scss': finalScss });
  let cold: JsonValue[];
  try {
    cold = factField(await coldP.op('scss_classes', {}), 'classes');
  } finally {
    await coldP.dispose();
  }

  assert.deepEqual(warm, cold, 'an incrementally-patched scss plugin must match a cold rebuild');
  assert.ok(warm.length === 2, 'sanity: both classes present');
});
