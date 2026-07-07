// t-994174 — a path-filtered `search_symbol` must never let a self-defeating filter read as a
// symbol ABSENCE (§3.4). Oracle: the same query with a KNOWN-good glob (`dir/**`) — a bare dir must
// match the SAME set (auto-expand), and a genuine path miss must fire an explicit note, never the
// plain "no symbols matching" that means true absence.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { project, type TestProject } from '../helpers/project.ts';
import type { OpResult } from '../../src/ops/contracts.ts';

const FILES = {
  'tsconfig.json': '{"compilerOptions":{"strict":true}}',
  'src/daemon/engine.ts': 'export class Engine { run() { return 1; } }\n',
  'src/daemon/host.ts': 'export const engineHost = 2;\n',
  'src/core/other.ts': 'export const Engineless = 3;\n',
};

function data(r: OpResult): { matches: unknown[]; note?: string } {
  assert.ok('result' in r && r.result.ok, `expected success, got ${JSON.stringify(r)}`);
  return r.result.data as { matches: unknown[]; note?: string };
}

test('bare-dir pathInclude matches the SAME set as the explicit /** glob (auto-expand)', async () => {
  const p: TestProject = await project(FILES);
  try {
    const bare = data(
      await p.op('search_symbol', { query: 'Engine', pathInclude: ['src/daemon'] }),
    );
    const glob = data(
      await p.op('search_symbol', { query: 'Engine', pathInclude: ['src/daemon/**'] }),
    );
    assert.ok(bare.matches.length > 0, 'bare dir must not read as empty');
    assert.equal(
      JSON.stringify(bare.matches),
      JSON.stringify(glob.matches),
      'bare `src/daemon` == `src/daemon/**`',
    );
  } finally {
    await p.dispose();
  }
});

test('a genuine path miss fires the honesty note (filter excluded all), NOT a symbol absence', async () => {
  const p: TestProject = await project(FILES);
  try {
    const miss = data(
      await p.op('search_symbol', { query: 'Engine', pathInclude: ['src/deamon'] }), // typo
    );
    assert.equal(miss.matches.length, 0, 'the typo path admits nothing');
    assert.match(miss.note ?? '', /excluded them all|path filter/i, 'note blames the path filter');
    assert.match(miss.note ?? '', /NOT a symbol absence/i, 'note explicitly denies absence');
  } finally {
    await p.dispose();
  }
});

test('a true no-such-symbol keeps the plain absence note (no false path blame)', async () => {
  const p: TestProject = await project(FILES);
  try {
    const absent = data(await p.op('search_symbol', { query: 'ZzzNoSuchSymbol' }));
    assert.equal(absent.matches.length, 0);
    assert.match(
      absent.note ?? '',
      /no symbols matching/i,
      'plain absence, not a path-filter note',
    );
  } finally {
    await p.dispose();
  }
});

test('an exact file path (wildcard-less) still matches itself', async () => {
  const p: TestProject = await project(FILES);
  try {
    const exact = data(
      await p.op('search_symbol', { query: 'Engine', pathInclude: ['src/daemon/engine.ts'] }),
    );
    assert.ok(exact.matches.length > 0, 'a bare FILE path must keep matching itself');
  } finally {
    await p.dispose();
  }
});

test('pathExclude is symmetric — a bare dir excludes everything under it', async () => {
  const p: TestProject = await project(FILES);
  try {
    const excl = data(
      await p.op('search_symbol', { query: 'Engine', pathExclude: ['src/daemon'] }),
    );
    for (const m of excl.matches as { span?: { file?: string } }[]) {
      assert.doesNotMatch(
        m.span?.file ?? '',
        /^src\/daemon\//,
        'no src/daemon/ file survives the exclude',
      );
    }
  } finally {
    await p.dispose();
  }
});
