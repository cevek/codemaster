// t-424583 — the symbol/registry/move ops must accept the intuitive arg spelling the op-map's
// INTENT implies (§7 Postel): search_symbol `name`→`query`, list `query`→`registry`, move_file
// `from`/`to`→`source`/`dest`, move_symbol `to`→`dest`. Oracle = the canonical-form call (same
// result), and the rewrite is disclosed via `Result.intake`; the canonical schema stays sole gate.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { project, type TestProject } from '../helpers/project.ts';
import type { OpResult } from '../../src/ops/contracts.ts';

const FILES = {
  'tsconfig.json': '{"compilerOptions":{"strict":true,"jsx":"react-jsx"}}',
  'src/util.ts': 'export function getInitials(name: string) { return name[0] ?? ""; }\n',
  'src/consumer.ts': "import { getInitials } from './util';\nexport const a = getInitials('y');\n",
};

function okResult(r: OpResult): { data: unknown; intake: readonly string[] } {
  assert.ok('result' in r && r.result.ok, `expected success, got ${JSON.stringify(r)}`);
  return { data: r.result.data, intake: r.result.intake ?? [] };
}
const dataJson = (r: OpResult): string => JSON.stringify(okResult(r).data);

test('search_symbol — `name` is the alias of `query`; same result + note', async () => {
  const p: TestProject = await project(FILES);
  try {
    const bad = await p.op('search_symbol', { name: 'getInitials' });
    const canon = await p.op('search_symbol', { query: 'getInitials' });
    assert.equal(dataJson(bad), dataJson(canon), 'name form == query form');
    assert.deepEqual(okResult(bad).intake, ['name→query']);
    assert.deepEqual(okResult(canon).intake, [], 'canonical form fires no rewrite');
  } finally {
    await p.dispose();
  }
});

test('list — `query` is the alias of `registry`; same result + note', async () => {
  const p: TestProject = await project(FILES);
  try {
    const bad = await p.op('list', { query: 'components' });
    const canon = await p.op('list', { registry: 'components' });
    assert.equal(dataJson(bad), dataJson(canon), 'query form == registry form');
    assert.deepEqual(okResult(bad).intake, ['query→registry']);
  } finally {
    await p.dispose();
  }
});

test('move_file — `from`/`to` alias `source`/`dest`; same dry-run + note', async () => {
  const p: TestProject = await project(FILES);
  try {
    const bad = await p.op('move_file', { from: 'src/util.ts', to: 'src/util2.ts' });
    const canon = await p.op('move_file', { source: 'src/util.ts', dest: 'src/util2.ts' });
    assert.equal(dataJson(bad), dataJson(canon), 'from/to form == source/dest form');
    assert.deepEqual(okResult(bad).intake, ['from→source', 'to→dest']);
    assert.deepEqual(okResult(canon).intake, [], 'canonical form fires no rewrite');
  } finally {
    await p.dispose();
  }
});

test('move_symbol — `to` aliases `dest`; keeps the shared symbol target intake', async () => {
  const p: TestProject = await project(FILES);
  try {
    const bad = await p.op('move_symbol', { name: 'getInitials', to: 'src/consumer.ts' });
    const canon = await p.op('move_symbol', { name: 'getInitials', dest: 'src/consumer.ts' });
    assert.equal(dataJson(bad), dataJson(canon), 'to form == dest form');
    assert.deepEqual(okResult(bad).intake, ['to→dest']);
  } finally {
    await p.dispose();
  }
});
