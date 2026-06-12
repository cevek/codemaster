// Unit tests for support/ wrappers, oracle = git itself / the files we just wrote.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import * as path from 'node:path';
import type { RepoRelPath } from '../../src/core/brands.ts';
import { project } from '../helpers/project.ts';
import { gitLsFiles } from '../../src/support/git/ls-files.ts';
import { gitLog } from '../../src/support/git/log.ts';
import { gitBlame } from '../../src/support/git/blame.ts';
import { gitRepoFingerprint } from '../../src/support/git/fingerprint.ts';
import { canonicalizeRoot, mintRepoRelPath } from '../../src/support/fs/canonicalize.ts';
import { statFingerprint, hashFileContent } from '../../src/support/fs/stat-fingerprint.ts';
import { walkFiles } from '../../src/support/fs/walk.ts';
import { loadConfig } from '../../src/support/config-load/load.ts';

test('git wrappers answer honestly on a real fixture repo', async () => {
  const p = await project({ 'a.txt': 'hello\n', 'sub/b.txt': 'world\n' });
  try {
    const files = await gitLsFiles(p.root);
    assert.ok(files.ok);
    assert.deepEqual([...files.data].sort(), ['a.txt', 'sub/b.txt']);

    const log = await gitLog(p.root, { maxCount: 5 });
    assert.ok(log.ok);
    assert.equal(log.data[0]?.subject, 'fixture');

    const blame = await gitBlame(p.root, 'a.txt', 1, 1);
    assert.ok(blame.ok);
    assert.equal(blame.data[0]?.summary, 'fixture');

    const clean = await gitRepoFingerprint(p.root);
    assert.ok(clean.ok && clean.data.dirtyPaths.length === 0);
    p.write('a.txt', 'changed\n');
    const dirty = await gitRepoFingerprint(p.root);
    assert.ok(dirty.ok);
    assert.deepEqual(dirty.data.dirtyPaths, ['a.txt']);
    assert.notEqual(dirty.data.fingerprint, clean.data.fingerprint);
  } finally {
    await p.dispose();
  }
});

test('fs wrappers: canonical minting, stat fingerprints, walk', async () => {
  const p = await project({ 'src/File.ts': 'export const x = 1;\n' });
  try {
    const canon = canonicalizeRoot(p.root);
    assert.ok(canon.ok);

    const minted = mintRepoRelPath(canon.root, path.join(canon.root, 'src', 'File.ts'));
    assert.ok(minted.ok);
    assert.equal(minted.path, 'src/File.ts');
    assert.equal(minted.casing, 'on-disk');

    const escape = mintRepoRelPath(canon.root, '../outside.ts');
    assert.ok(!escape.ok, 'a path escaping the root must be refused');

    const stat = statFingerprint(canon.root, 'src/File.ts' as RepoRelPath, 123);
    assert.ok(stat.state === 'present' && stat.fingerprint.size > 0);
    assert.equal(statFingerprint(canon.root, 'nope.ts' as RepoRelPath, 123).state, 'absent');

    const hashed = hashFileContent(canon.root, 'src/File.ts' as RepoRelPath);
    assert.ok(hashed.ok && hashed.hash.length === 40);

    const walked = walkFiles(canon.root);
    assert.ok(walked.ok);
    assert.ok(walked.data.some((f) => f.path === 'src/File.ts'));
    assert.ok(!walked.data.some((f) => f.path.includes('.git/')), 'default ignores hold');
  } finally {
    await p.dispose();
  }
});

test('config load: valid file parses, unknown key fails pointedly, none is fine', async () => {
  const p = await project({ 'src/x.ts': 'export const x = 1;\n' });
  try {
    assert.ok(loadConfig(p.root).ok, 'no config file → defaults');

    writeFileSync(
      path.join(p.root, 'codemaster.config.ts'),
      `import { defineConfig } from 'codemaster';\nexport default defineConfig({ output: { verbosity: 'terse' } });\n`,
    );
    const loaded = loadConfig(p.root);
    assert.ok(loaded.ok);
    assert.equal(loaded.data.config.output?.verbosity, 'terse');
    assert.ok(loaded.data.source?.endsWith('codemaster.config.ts'));

    writeFileSync(path.join(p.root, 'codemaster.config.ts'), `export default { outputz: {} };\n`);
    const bad = loadConfig(p.root);
    assert.ok(!bad.ok);
    assert.match(bad.failure.message, /outputz/);
  } finally {
    await p.dispose();
  }
});
