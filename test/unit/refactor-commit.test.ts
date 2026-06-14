// Unit oracle for the move/extract commit+rollback primitives (commitMove / revertMove,
// §2.9/§2.10), driven directly on a real temp git repo — independent of the op layer. The
// load-bearing property: revertMove restores PRE-OP bytes (dirty edits included), NEVER HEAD,
// and removes only what the op created (a folder move's `-r` dest dir, not a carried child).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { RepoRelPath } from '../../src/core/brands.ts';
import { commitMove, revertMove } from '../../src/ops/refactor-commit.ts';

test('revertMove handles a folder move: -r removal + carried-child not HEAD-checked out', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'cm-movedir-'));
  const git = (...a: string[]): string =>
    execFileSync('git', a, { cwd: dir, encoding: 'utf8' }).trim();
  try {
    mkdirSync(path.join(dir, 'src', 'old'), { recursive: true });
    writeFileSync(path.join(dir, 'src', 'shared.ts'), 'export const s = 1;\n');
    writeFileSync(
      path.join(dir, 'src', 'old', 'a.ts'),
      "import { s } from '../shared';\nexport const a = s;\n",
    );
    writeFileSync(path.join(dir, 'src', 'old', 'b.ts'), 'export const b = 2;\n');
    git('init', '-q');
    git('config', 'user.email', 't@t.t');
    git('config', 'user.name', 't');
    git('add', '-A');
    git('commit', '-q', '-m', 'init');

    // Folder move src/old → src/deep/new (one entry, kind:dir); a.ts is a carried child whose
    // own import was rewritten → it appears in contentWrites at the NEW path.
    const plan = {
      moves: [
        { from: 'src/old' as RepoRelPath, to: 'src/deep/new' as RepoRelPath, kind: 'dir' as const },
      ],
      newFiles: [],
      contentWrites: [
        {
          path: 'src/deep/new/a.ts' as RepoRelPath,
          content: "import { s } from '../../shared';\nexport const a = s;\n",
        },
      ],
    };
    const committed = await commitMove(dir, plan);
    assert.ok(committed.ok);
    assert.deepEqual(git('ls-files').split('\n').sort(), [
      'src/deep/new/a.ts',
      'src/deep/new/b.ts',
      'src/shared.ts',
    ]);

    const reverted = await revertMove(dir, {
      restore: [
        {
          path: 'src/old/a.ts' as RepoRelPath,
          content: "import { s } from '../shared';\nexport const a = s;\n",
        },
        { path: 'src/old/b.ts' as RepoRelPath, content: 'export const b = 2;\n' },
      ],
      remove: ['src/deep/new' as RepoRelPath],
    });
    assert.equal(reverted.complete, true); // -r removed the dir; carried child restored at old path
    assert.deepEqual(git('ls-files').split('\n').sort(), [
      'src/old/a.ts',
      'src/old/b.ts',
      'src/shared.ts',
    ]);
    assert.equal(git('status', '--porcelain'), '');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('revertMove restores the working tree byte-exact (rollback unit)', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'cm-move-'));
  const git = (...a: string[]): string =>
    execFileSync('git', a, { cwd: dir, encoding: 'utf8' }).trim();
  try {
    mkdirSync(path.join(dir, 'src'), { recursive: true });
    writeFileSync(path.join(dir, 'src', 'a.ts'), 'export const a = 1;\n');
    writeFileSync(path.join(dir, 'src', 'b.ts'), "import { a } from './a';\nexport const b = a;\n");
    git('init', '-q');
    git('config', 'user.email', 't@t.t');
    git('config', 'user.name', 't');
    git('add', '-A');
    git('commit', '-q', '-m', 'init');

    const committed = await commitMove(dir, {
      moves: [{ from: 'src/a.ts' as RepoRelPath, to: 'src/sub/a.ts' as RepoRelPath, kind: 'file' }],
      newFiles: [],
      contentWrites: [
        { path: 'src/sub/a.ts' as RepoRelPath, content: 'export const a = 1; // moved\n' },
        {
          path: 'src/b.ts' as RepoRelPath,
          content: "import { a } from './sub/a';\nexport const b = a;\n",
        },
      ],
    });
    assert.ok(committed.ok);
    assert.deepEqual(git('ls-files').split('\n').sort(), ['src/b.ts', 'src/sub/a.ts']);

    const reverted = await revertMove(dir, {
      restore: [
        { path: 'src/a.ts' as RepoRelPath, content: 'export const a = 1;\n' },
        {
          path: 'src/b.ts' as RepoRelPath,
          content: "import { a } from './a';\nexport const b = a;\n",
        },
      ],
      remove: ['src/sub/a.ts' as RepoRelPath],
    });
    assert.equal(reverted.complete, true);
    assert.deepEqual(git('ls-files').split('\n').sort(), ['src/a.ts', 'src/b.ts']);
    assert.equal(readFileSync(path.join(dir, 'src', 'a.ts'), 'utf8'), 'export const a = 1;\n');
    assert.equal(git('status', '--porcelain'), ''); // clean again
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('revertMove restores PRE-OP content, not HEAD — never loses uncommitted edits', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'cm-move-dirty-'));
  const git = (...a: string[]): string =>
    execFileSync('git', a, { cwd: dir, encoding: 'utf8' }).trim();
  try {
    mkdirSync(path.join(dir, 'src'), { recursive: true });
    writeFileSync(path.join(dir, 'src', 'x.ts'), 'export const x = 0; // C0\n'); // committed
    git('init', '-q');
    git('config', 'user.email', 't@t.t');
    git('config', 'user.name', 't');
    git('add', '-A');
    git('commit', '-q', '-m', 'init');

    // Uncommitted edit (the dirtyOk scenario): the worktree now differs from HEAD.
    const preOp = 'export const x = 1; // C1 uncommitted\n';
    writeFileSync(path.join(dir, 'src', 'x.ts'), preOp);

    // An op writes C2, then rolls back. Revert must restore C1 (pre-op), NOT C0 (HEAD).
    await commitMove(dir, {
      moves: [],
      newFiles: [],
      contentWrites: [
        { path: 'src/x.ts' as RepoRelPath, content: 'export const x = 2; // C2 op\n' },
      ],
    });
    const reverted = await revertMove(dir, {
      restore: [{ path: 'src/x.ts' as RepoRelPath, content: preOp }],
      remove: [],
    });
    assert.equal(reverted.complete, true);
    assert.equal(readFileSync(path.join(dir, 'src', 'x.ts'), 'utf8'), preOp); // C1, not C0
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('revertMove reports an index-reset failure honestly (worktree still restored)', async () => {
  // The worktree restore is the DATA guarantee; a failed `git reset` (here: not a git repo)
  // leaves only the index unreset. It must be surfaced (note), not overclaimed as a fully clean
  // revert — and must NOT mark the revert incomplete, since no data was lost.
  const dir = mkdtempSync(path.join(os.tmpdir(), 'cm-nogit-'));
  try {
    mkdirSync(path.join(dir, 'src'), { recursive: true });
    const reverted = await revertMove(dir, {
      restore: [{ path: 'src/x.ts' as RepoRelPath, content: 'export const x = 1;\n' }],
      remove: [],
    });
    assert.equal(reverted.complete, true); // data restored — not incomplete
    assert.match(String(reverted.note), /index not reset|not reset/); // index issue surfaced
    assert.equal(readFileSync(path.join(dir, 'src', 'x.ts'), 'utf8'), 'export const x = 1;\n');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
