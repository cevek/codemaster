// git prints `status --porcelain` / `diff --name-only` paths relative to the repository TOPLEVEL;
// a workspace root may be a subdirectory of it (t-835778). Oracle: real git over a real repo whose
// workspace is `pkg/`, and the paths we wrote.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { project } from '../helpers/project.ts';
import { rebaseOnPrefix } from '../../src/common/git-path/rebase.ts';
import { gitStatus } from '../../src/support/git/status.ts';
import { gitDiffNames } from '../../src/support/git/diff-changed.ts';
import { gitDiffAgainst } from '../../src/support/git/diff-against.ts';
import { captureWorktree, worktreeDrift } from '../../src/support/git/worktree-snapshot.ts';
import { preWriteCheck } from '../../src/ops/post-apply-verify.ts';
import type { RepoRelPath } from '../../src/core/brands.ts';

test('rebaseOnPrefix: inside → root-relative, outside → ../, the root entry itself dropped', () => {
  assert.deepEqual(rebaseOnPrefix(['a.ts', 'pkg/b.ts'], ''), {
    inside: ['a.ts', 'pkg/b.ts'],
    outside: [],
  });
  assert.deepEqual(
    rebaseOnPrefix(['pkg/src/a.ts', 'shared/x.ts', 'pkgx/y.ts', 'pkg', 'a/b/c.ts'], 'a/pkg/'),
    {
      inside: [],
      outside: [
        '../../pkg/src/a.ts',
        '../../shared/x.ts',
        '../../pkgx/y.ts',
        '../../pkg',
        '../b/c.ts',
      ],
    },
  );
  assert.deepEqual(rebaseOnPrefix(['pkg/src/a.ts', 'pkg', 'pkgx/y.ts'], 'pkg/'), {
    inside: ['src/a.ts'],
    outside: ['../pkgx/y.ts'],
  });
});

const FILES = {
  'tsconfig.json': '{"include":["src"]}',
  'src/a.ts': 'export const a = 1;\n',
  '../shared/x.ts': 'export const x = 1;\n',
};

test('gitStatus / gitDiffNames / gitDiffAgainst in a subdirectory root: workspace-relative paths', async () => {
  const p = await project(FILES, { subdir: 'pkg' });
  try {
    const base = p.git('rev-parse', 'HEAD').trim();
    p.write('src/a.ts', 'export const a = 2;\n');
    p.write('../shared/x.ts', 'export const x = 2;\n');
    const st = await gitStatus(p.root);
    assert.ok(st.ok);
    assert.deepEqual(st.data.dirtyPaths, ['src/a.ts']);
    assert.deepEqual(st.data.outsideRoot, ['../shared/x.ts']);

    p.commit('both');
    const head = p.git('rev-parse', 'HEAD').trim();
    const names = await gitDiffNames(p.root, base, head);
    assert.ok(names.ok);
    assert.deepEqual(names.data, ['src/a.ts']);

    p.write('src/new.ts', 'export {};\n');
    const against = await gitDiffAgainst(p.root, base);
    assert.ok(against.ok);
    assert.deepEqual(against.data, {
      inside: ['src/a.ts', 'src/new.ts'],
      outside: ['../shared/x.ts'],
    });
  } finally {
    await p.dispose();
  }
});

test('preWriteCheck in a subdirectory root: a dirty touched file refuses without dirtyOk', async () => {
  const p = await project(FILES, { subdir: 'pkg' });
  try {
    p.write('src/a.ts', 'export const a = 2;\n');
    const r = await preWriteCheck(
      p.root,
      undefined,
      ['src/a.ts' as RepoRelPath],
      [],
      false,
      () => true,
    );
    assert.ok(r.ok);
    assert.match(String(r.data), /uncommitted changes \(src\/a\.ts\)/);
  } finally {
    await p.dispose();
  }
});

test('captureWorktree in a subdirectory root: a re-edit of an already-dirty file outside the root is drift', async () => {
  const p = await project(FILES, { subdir: 'pkg' });
  try {
    p.write('../shared/x.ts', 'export const x = 2;\n');
    const before = await captureWorktree(p.root, () => true);
    p.write('../shared/x.ts', 'export const x = 3;\n');
    const after = await captureWorktree(p.root, () => true);
    assert.ok(before.ok && after.ok);
    assert.deepEqual(worktreeDrift(before.data, after.data), [
      { path: '../shared/x.ts', deleted: false },
    ]);
  } finally {
    await p.dispose();
  }
});
