// Unit tests for support/ wrappers, oracle = git itself / the files we just wrote.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdtempSync, mkdirSync, symlinkSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import type { RepoRelPath } from '../../src/core/brands.ts';
import { project } from '../helpers/project.ts';
import { gitLsFiles } from '../../src/support/git/ls-files.ts';
import { gitLog } from '../../src/support/git/log.ts';
import { gitBlame } from '../../src/support/git/blame.ts';
import { gitRepoFingerprint } from '../../src/support/git/fingerprint.ts';
import {
  canonicalizeRoot,
  mintRepoRelPath,
  type Realpath,
} from '../../src/support/fs/canonicalize.ts';
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

test('walk excludes .claude (agent worktrees) — gitignored whole-tree copies must not be indexed', async () => {
  // `.claude/worktrees/<id>` holds whole-tree COPIES of the repo; the non-git walk (scss/i18n/
  // schema + the freshness backstop) must skip them or every source file is indexed N times over.
  const p = await project({
    'src/App.tsx': 'export const App = 1;\n',
    '.claude/worktrees/dupe/src/App.tsx': 'export const App = 1;\n',
  });
  try {
    const canon = canonicalizeRoot(p.root);
    assert.ok(canon.ok);
    const walked = walkFiles(canon.root);
    assert.ok(walked.ok);
    assert.ok(
      walked.data.some((f) => f.path === 'src/App.tsx'),
      'real source still walked',
    );
    assert.ok(
      !walked.data.some((f) => f.path.includes('.claude/')),
      '.claude (worktree tree-copies) must be excluded',
    );
  } finally {
    await p.dispose();
  }
});

test('§19 canonicalization: case-fold collapses spellings, symlink resolves, escape refused', () => {
  // Deterministic and FS-INDEPENDENT: the casing/symlink verdict is injected, so the test
  // does not depend on whether the CI volume happens to be case-insensitive (§19).
  const root = '/repo';

  // A case-insensitive volume folds every spelling of src/foo.tsx onto the on-disk Foo.tsx.
  const caseFold: Realpath = (abs) =>
    abs.toLowerCase().endsWith('/src/foo.tsx') ? '/repo/src/Foo.tsx' : abs;
  const upper = mintRepoRelPath(root, '/repo/src/FOO.tsx', caseFold);
  const lower = mintRepoRelPath(root, '/repo/src/foo.tsx', caseFold);
  assert.ok(upper.ok && lower.ok);
  assert.equal(upper.path, lower.path, 'two spellings of one file brand to ONE RepoRelPath');
  assert.equal(upper.path, 'src/Foo.tsx', 'branded to the true on-disk casing');
  assert.equal(upper.casing, 'on-disk');

  // A symlink resolves (realpath) to its target inside the repo.
  const symlink: Realpath = (abs) => (abs.endsWith('/src/link.ts') ? '/repo/src/real.ts' : abs);
  const linked = mintRepoRelPath(root, '/repo/src/link.ts', symlink);
  assert.ok(linked.ok && linked.path === 'src/real.ts', 'a symlink keys to its real target');

  // A symlink whose real location escapes the root is refused, never mis-keyed inside it.
  const escaping: Realpath = (abs) => (abs.endsWith('/src/evil.ts') ? '/elsewhere/evil.ts' : abs);
  const escaped = mintRepoRelPath(root, '/repo/src/evil.ts', escaping);
  assert.ok(!escaped.ok, 'a symlink resolving outside the root is refused');

  // A path that does not exist (deleted / about to be created) — realpath throws, so casing
  // is honestly labelled `syntactic-only`, but the path still mints (callers must create it).
  const missing: Realpath = () => {
    throw new Error('ENOENT');
  };
  const ghost = mintRepoRelPath(root, '/repo/src/new.ts', missing);
  assert.ok(ghost.ok && ghost.path === 'src/new.ts', 'a not-yet-existing path mints syntactically');
  assert.equal(
    ghost.casing,
    'syntactic-only',
    'unproven casing is labelled, never claimed on-disk',
  );
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

// A hermetic tmp dir the test owns end-to-end — created, exercised, removed. The symlink-cycle
// case would spin the OLD `statSync`-follow walk forever, so it must NEVER be run against a
// borrowed tree (t-895142). `realpathSync` canonicalizes macOS `/var → /private/var` so the
// ancestor symlinks point at the true root.
function withTmp(build: (dir: string) => void, run: (dir: string) => void): void {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'cm-walk-')));
  try {
    build(dir);
    run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('§1 walk: K≥2 ancestor-symlink cycle terminates BOUNDED with partial, never hangs', () => {
  withTmp(
    (dir) => {
      const pkg = path.join(dir, 'pkg');
      mkdirSync(pkg);
      writeFileSync(path.join(pkg, 'a.ts'), 'export const X = 1;\n');
      writeFileSync(path.join(pkg, 'b.ts'), 'export const Y = 2;\n');
      // The exact incident shape: ≥2 symlinks to an ancestor. The OLD walk exploded into
      // ~K^32 virtual paths; the bounded walk skips them and returns immediately.
      symlinkSync(dir, path.join(pkg, 'back1'), 'dir');
      symlinkSync(dir, path.join(pkg, 'back2'), 'dir');
    },
    (dir) => {
      const walked = walkFiles(path.join(dir, 'pkg'));
      // Un-followed symlinks are honest incompleteness — partial, never silent (§3.4).
      assert.ok(!walked.ok, 'a walk that skipped symlinks discloses partial');
      assert.equal(walked.failure.partial, true);
      assert.match(walked.failure.message, /symlink\(s\) not followed/);
      assert.ok(walked.data, 'the real files are still returned alongside the disclosure');
      const paths = (walked.data ?? []).map((f) => f.path);
      assert.deepEqual([...paths].sort(), ['a.ts', 'b.ts'], 'real source found, cycle broken');
    },
  );
});

test('§1 walk: wall-clock deadline overrun returns ToolFailure{timeout}, never spins', () => {
  withTmp(
    (dir) => {
      // Ten top-level files so the walk collects several entries BEFORE the deadline trips —
      // exercises a mid-walk crossing, not just an already-past deadline.
      for (let i = 0; i < 10; i++)
        writeFileSync(path.join(dir, `f${i}.ts`), 'export const n = 1;\n');
    },
    (dir) => {
      // An advancing clock: the deadline is crossed on a LATER poll, so the sync walk collects
      // some files and then stops — the REAL §1 time-deadline mechanism firing mid-walk.
      let t = 100;
      const now = () => (t += 10);
      const walked = walkFiles(dir, { now, deadlineMs: 155 });
      assert.ok(!walked.ok, 'an overrun walk fails, never a complete-looking answer');
      assert.equal(walked.failure.tool, 'timeout', 'the §1 timeout mechanism, labelled honestly');
      assert.equal(walked.failure.partial, true);
      const collected = (walked.data ?? []).length;
      assert.ok(collected > 0 && collected < 10, 'stopped mid-walk: some collected, not all');

      // And the already-past edge: a deadline behind the first poll stops immediately.
      let u = 100;
      const past = walkFiles(dir, { now: () => (u += 10), deadlineMs: 0 });
      assert.ok(!past.ok && past.failure.tool === 'timeout', 'an already-past deadline trips too');
    },
  );
});

test('§1 walk: entry-count cap bounds a large acyclic tree with a partial (size bound)', () => {
  withTmp(
    (dir) => {
      for (let i = 0; i < 20; i++)
        writeFileSync(path.join(dir, `f${i}.ts`), 'export const n = 1;\n');
    },
    (dir) => {
      const walked = walkFiles(dir, { maxEntries: 5 });
      assert.ok(!walked.ok, 'hitting the entry cap discloses partial, never a silent truncation');
      assert.equal(walked.failure.partial, true);
      assert.match(walked.failure.message, /entry cap 5 reached/);
      assert.ok((walked.data ?? []).length <= 5, 'the cap actually bounded the collected set');
    },
  );
});

test('§1 walk: a clean tree with no symlinks still returns ok and finds real files', () => {
  withTmp(
    (dir) => {
      mkdirSync(path.join(dir, 'src'));
      writeFileSync(path.join(dir, 'src', 'App.tsx'), 'export const App = 1;\n');
    },
    (dir) => {
      const walked = walkFiles(dir);
      assert.ok(walked.ok, 'a symlink-free tree is complete — no spurious partial');
      assert.ok(
        walked.data.some((f) => f.path === 'src/App.tsx'),
        'normal discovery intact',
      );
    },
  );
});
