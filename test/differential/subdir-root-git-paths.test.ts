// A workspace root that is a SUBDIRECTORY of its git repository (an explicit `root:<pkg>`): the
// read-time freshness backstop (§3.5) and `affected` consume git's change sets, which git reports
// toplevel-relative (t-835778). Watcher silenced; oracles are the bytes we wrote and the paths git
// reports.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { project } from '../helpers/project.ts';
import type { OpResult } from '../../src/ops/contracts.ts';
import type { JsonValue } from '../../src/core/json.ts';

const FILES = {
  'tsconfig.json': '{"compilerOptions":{"strict":true},"include":["src"]}',
  'src/dto.ts': 'export interface U { a: string }\n',
  'src/dto.test.ts': "import type { U } from './dto';\nexport const u: U = { a: '' };\n",
};

function okResult(r: OpResult) {
  assert.ok('result' in r && r.result.ok, JSON.stringify(r));
  return r.result;
}

const members = (r: OpResult): string[] =>
  ((okResult(r).data as { members?: { name: string }[] }).members ?? []).map((m) => m.name);

test('subdirectory root: an in-place edit is reindexed on read, never served stale', async () => {
  const p = await project(FILES, { subdir: 'pkg' });
  try {
    assert.deepEqual(members(await p.op('expand_type', { name: 'U' })), ['a']);
    p.write('src/dto.ts', 'export interface U { a: string; b: number }\n');
    assert.deepEqual(members(await p.op('expand_type', { name: 'U' })), ['a', 'b']);
    // Already dirty: porcelain reads ` M` again — only the content check of the RIGHT path sees it.
    p.write('src/dto.ts', 'export interface U { a: string; b: number; c: boolean }\n');
    assert.deepEqual(members(await p.op('expand_type', { name: 'U' })), ['a', 'b', 'c']);
  } finally {
    await p.dispose();
  }
});

test('subdirectory root: the no-program syntactic surface sees a re-edit of a dirty file', async () => {
  const p = await project(FILES, { subdir: 'pkg' });
  const names = async (q: string): Promise<string[]> => {
    const r = okResult(await p.op('search_symbol', { query: q, syntactic: true }));
    return ((r.data as { matches?: { name: string }[] }).matches ?? []).map((m) => m.name);
  };
  try {
    p.write('src/dto.ts', 'export interface U { a: string }\nexport const firstZq = 1;\n');
    assert.ok((await names('firstZq')).includes('firstZq'));
    p.write('src/dto.ts', 'export interface U { a: string }\nexport const secondZq = 1;\n');
    assert.ok((await names('secondZq')).includes('secondZq'), 'stale surface');
  } finally {
    await p.dispose();
  }
});

// Pins the decision that the clean-commit anchor stays repository-wide.
test('subdirectory root: a dirty file outside the root withholds indexedAtCommit', async () => {
  const p = await project({ ...FILES, '../other.ts': 'export const o = 1;\n' }, { subdir: 'pkg' });
  try {
    const head = p.git('rev-parse', 'HEAD').trim();
    const clean = okResult(await p.op('expand_type', { name: 'U' }));
    assert.equal(clean.freshness?.indexedAtCommit, head);
    p.write('../other.ts', 'export const o = 2;\n');
    const dirty = okResult(await p.op('expand_type', { name: 'U' }));
    assert.equal(dirty.freshness?.indexedAtCommit, undefined);
  } finally {
    await p.dispose();
  }
});

test('subdirectory root: affected traces in-root changes and names out-of-root ones, incomplete', async () => {
  const p = await project({ ...FILES, '../other.ts': 'export const o = 1;\n' }, { subdir: 'pkg' });
  try {
    p.write('src/dto.ts', 'export interface U { a: string; z?: 1 }\n');
    p.write('../other.ts', 'export const o = 2;\n');
    const data = okResult(await p.op('affected', {})).data as Record<string, JsonValue>;
    assert.deepEqual(data['tests'], ['src/dto.test.ts']);
    const summary = data['summary'] as Record<string, JsonValue>;
    assert.equal(summary['complete'], false);
    const cs = data['changeSet'] as Record<string, JsonValue>;
    assert.equal(cs['traced'], 1);
    assert.deepEqual(cs['outsideRoot'], ['../other.ts']);
    assert.equal(cs['deleted'], undefined, 'an out-of-root change is not misread as deleted');
  } finally {
    await p.dispose();
  }
});
