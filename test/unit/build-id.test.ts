// The build id names the code a process runs (`<version> @<sha9>[+dirty]`), and must never name a
// checkout that is not codemaster's own — installed under another project's node_modules, git answers
// for THAT project. Oracle: a real temp git repo whose HEAD is read independently.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { computeBuildId } from '../../src/support/build-id/build-id.ts';

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'cm-build-id-'));
  git(dir, 'init', '-q');
  writeFileSync(join(dir, 'package.json'), '{"version":"9.9.9"}');
  git(dir, 'add', '.');
  git(dir, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'x');
  return dir;
}

test('a clean checkout whose toplevel is the package root: version @sha9', () => {
  const dir = repo();
  try {
    const sha = git(dir, 'rev-parse', 'HEAD').slice(0, 9);
    assert.equal(computeBuildId(dir, '9.9.9'), `9.9.9 @${sha}`);
    writeFileSync(join(dir, 'new.ts'), 'x');
    assert.equal(computeBuildId(dir, '9.9.9'), `9.9.9 @${sha}+dirty`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('nested inside another git project, or outside git: @unknown, never the host HEAD', () => {
  const host = repo();
  const bare = mkdtempSync(join(tmpdir(), 'cm-build-id-bare-'));
  try {
    const nested = join(host, 'node_modules', 'codemaster');
    mkdirSync(nested, { recursive: true });
    assert.equal(computeBuildId(nested, '9.9.9'), '9.9.9 @unknown');
    assert.equal(computeBuildId(bare, '9.9.9'), '9.9.9 @unknown');
  } finally {
    rmSync(host, { recursive: true, force: true });
    rmSync(bare, { recursive: true, force: true });
  }
});
