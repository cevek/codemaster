// Unit: `installedDependencies` (support/framework-detect) — the package.json reader the
// framework autodetect rides on. Oracle: a hand-written package.json on disk. Covers the
// honesty edges (missing / malformed → empty set, never a throw) the §3.6 contract requires.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { installedDependencies } from '../../src/support/framework-detect/installed.ts';

function withTmp(files: Record<string, string>, fn: (dir: string) => void): void {
  const dir = mkdtempSync(path.join(tmpdir(), 'fwdetect-'));
  try {
    for (const [rel, content] of Object.entries(files)) writeFileSync(path.join(dir, rel), content);
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('collects deps across all dependency fields', () => {
  withTmp(
    {
      'package.json': JSON.stringify({
        dependencies: { react: '18', 'react-dom': '18' },
        devDependencies: { typescript: '5' },
        peerDependencies: { '@tanstack/react-query': '5' },
        optionalDependencies: { zustand: '4' },
      }),
    },
    (dir) => {
      const deps = installedDependencies(dir);
      for (const n of ['react', 'react-dom', 'typescript', '@tanstack/react-query', 'zustand']) {
        assert.equal(deps.has(n), true, n);
      }
      assert.equal(deps.has('vue'), false);
    },
  );
});

test('missing package.json → empty set, no throw', () => {
  withTmp({}, (dir) => {
    assert.equal(installedDependencies(dir).size, 0);
  });
});

test('malformed package.json → empty set, no throw', () => {
  withTmp({ 'package.json': '{ not json' }, (dir) => {
    assert.equal(installedDependencies(dir).size, 0);
  });
});

test('package.json without dependency fields → empty set', () => {
  withTmp({ 'package.json': JSON.stringify({ name: 'x', version: '1' }) }, (dir) => {
    assert.equal(installedDependencies(dir).size, 0);
  });
});
