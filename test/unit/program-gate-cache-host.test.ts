// The gate caches over a REAL host: the disk version moves exactly where the LS's disk view does,
// and a warm gate answers what a cold host computes now. Oracle: a freshly built host (cold).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import type { RepoRelPath } from '../../src/core/brands.ts';
import ts from 'typescript';
import { createTsProjectHost } from '../../src/plugins/ts/ls-host.ts';
import { createSingleProgram } from '../../src/plugins/ts/program/single.ts';

const rel = (s: string) => s as RepoRelPath;
const FILES = [{ path: rel('src/b.ts'), content: 'export const z: number = 1;\n' }];
const SCOPE = { anchor: [rel('src/b.ts')], check: [rel('src/a.ts'), rel('src/b.ts')] };

function project(a: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'cm-gate-host-'));
  mkdirSync(path.join(dir, 'src'));
  writeFileSync(
    path.join(dir, 'tsconfig.json'),
    '{"compilerOptions":{"strict":true},"include":["src"]}',
  );
  writeFileSync(path.join(dir, 'package.json'), '{"name":"p"}');
  writeFileSync(path.join(dir, 'src/a.ts'), a);
  writeFileSync(path.join(dir, 'src/b.ts'), 'export const z = 0;\n');
  return dir;
}

function coldGate(dir: string) {
  const host = createTsProjectHost(dir);
  try {
    return host.gateAcross(FILES, SCOPE);
  } finally {
    host.dispose();
  }
}

test('the disk version moves on every reindex and never on an overlay', () => {
  const dir = project('export const a = 1;\n');
  const p = createSingleProgram(
    dir,
    path.join(dir, 'tsconfig.json'),
    'tsconfig.json',
    ts.createDocumentRegistry(),
    () => new Set(),
  );
  try {
    const v0 = p.diskVersion();
    const a = { abs: path.join(dir, 'src/a.ts'), content: 'export const a = 2;\n' };
    p.setOverlay([a]);
    p.clearOverlay();
    p.withMergedOverlay([a], [], () => undefined);
    assert.equal(p.diskVersion(), v0, 'no overlay operation moves the disk version');
    p.reindex([rel('src/a.ts')]);
    const v1 = p.diskVersion();
    assert.ok(v1 > v0, 'a source edit bumps it');
    p.reindex([rel('package.json')]);
    assert.ok(p.diskVersion() > v1, 'a non-source edit (resolution input) bumps it too');
  } finally {
    p.dispose();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a warm gate equals a cold host after a disk edit', () => {
  const dir = project('export const a = 1;\n');
  const host = createTsProjectHost(dir);
  try {
    host.gateAcross(FILES, SCOPE);
    host.gateAcross([{ path: rel('src/b.ts'), content: 'export const z = 2;\n' }], SCOPE);
    writeFileSync(path.join(dir, 'src/a.ts'), 'export const a: string = 1;\n');
    host.reindex([rel('src/a.ts')]);
    const warm = host.gateAcross(FILES, SCOPE);
    assert.ok(warm.baseline.length > 0, 'the edit introduced an error on disk');
    assert.deepEqual(warm, coldGate(dir));
  } finally {
    host.dispose();
    rmSync(dir, { recursive: true, force: true });
  }
});
