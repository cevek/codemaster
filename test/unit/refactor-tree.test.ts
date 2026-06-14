// Stage C oracle for plugins/ts/refactor/tree/. Two oracles: (1) the seven §2.3 tree
// invariants as direct assertions on the model, and (2) a REPLAY oracle — apply a
// move/rename/extract sequence to a real temp git repo by executing `commit-plan`'s output,
// then assert the on-disk layout (`git ls-files`) equals every node's `currentPath()` claim.
// The replay fixture is built deliberately to exercise BOTH ancestor-carried moves and a
// renamed child whose source path is computed off its moved ancestor — a flat or single-move
// fixture would pass even with `explainedBy`/`actualOnDiskPath` broken.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { RepoRelPath } from '../../src/core/brands.ts';
import { buildTree, loadTreeFromGit } from '../../src/plugins/ts/refactor/tree/build.ts';
import { computeCommitPlan } from '../../src/plugins/ts/refactor/tree/commit-plan.ts';
import { isOk } from '../../src/common/result/narrow.ts';

const rel = (s: string): RepoRelPath => s as RepoRelPath;
function listing(...paths: string[]): RepoRelPath[] {
  return paths.map(rel);
}

test('invariant 1+2: an ancestor move cascades; initial-path lookup stays stable', () => {
  const tree = buildTree(listing('a/b/c.ts'));
  const dirA = tree.findByCurrentPath(rel('a'));
  assert.ok(dirA);
  dirA?.rename('a2');
  const c = tree.findByInitialPath(rel('a/b/c.ts')); // resolve OLD, emit NEW
  assert.ok(c);
  assert.equal(c?.currentPath(), 'a2/b/c.ts'); // descendant followed for free
});

test('invariant 3: content overrides survive a move (keyed by node identity)', () => {
  const tree = buildTree(listing('a/b/c.ts'));
  const c = tree.findByInitialPath(rel('a/b/c.ts'));
  assert.ok(c);
  c?.setContent('EDITED');
  const dst = tree.ensureDirAtCurrent(rel('moved'));
  c?.moveTo(dst);
  assert.equal(c?.currentPath(), 'moved/c.ts');
  assert.equal(c?.contentOverride(), 'EDITED'); // content moved with the node
});

test('invariant 4: synthetic new file; byInitialPath collision is surfaced, not clobbered', () => {
  const tree = buildTree(listing('dir/Foo.tsx'));
  const foo = tree.findByInitialPath(rel('dir/Foo.tsx'));
  const other = tree.ensureDirAtCurrent(rel('OtherDir'));
  assert.ok(foo);
  foo?.moveTo(other); // Foo now at OtherDir/Foo.tsx; initial 'dir/Foo.tsx' still indexed

  // A happy synthetic node.
  const created = tree.addFileAtCurrent(other, 'New.tsx', 'export const N = 1;');
  assert.equal(created.synthetic, true);
  assert.equal(created.currentPath(), 'OtherDir/New.tsx');
  assert.equal(tree.findByInitialPath(rel('OtherDir/New.tsx')), created);

  // A synthetic whose path matches a moved-away node's initial path MUST throw, not hijack.
  const dirNode = tree.findByCurrentPath(rel('dir'));
  assert.ok(dirNode);
  if (dirNode) {
    assert.throws(() => tree.addFileAtCurrent(dirNode, 'Foo.tsx', 'x'), /byInitialPath collision/);
  }
});

test('invariant 5: sibling neighbourhood is a structural lookup (the .scss carry source)', () => {
  const tree = buildTree(listing('comp/Card.tsx', 'comp/Card.module.scss'));
  const card = tree.findByCurrentPath(rel('comp/Card.tsx'));
  assert.ok(card?.parent);
  const sibling = card?.parent?.childByCurrent('Card.module.scss');
  assert.equal(sibling?.currentPath(), 'comp/Card.module.scss');
});

test('invariant 6: collision-check-first — a failed rename/move leaves state unchanged', () => {
  const tree = buildTree(listing('p/a.ts', 'p/b.ts'));
  const a = tree.findByInitialPath(rel('p/a.ts'));
  assert.ok(a);
  assert.throws(() => a?.rename('b.ts'), /name collision/);
  assert.equal(a?.currentName, 'a.ts'); // unchanged after the failed rename
  const otherDir = tree.ensureDirAtCurrent(rel('q'));
  // Pre-occupy q/a.ts then attempt a colliding move.
  tree.addFileAtCurrent(otherDir, 'a.ts', 'x');
  assert.throws(() => a?.moveTo(otherDir), /name collision/);
  assert.equal(a?.currentPath(), 'p/a.ts'); // still home
});

test('invariant 7: dual child indices — rename re-keys current only; siblings untouched', () => {
  const tree = buildTree(listing('p/a.ts', 'p/b.ts'));
  const p = tree.findByCurrentPath(rel('p'));
  const a = p?.childByCurrent('a.ts');
  const b = p?.childByCurrent('b.ts');
  assert.ok(a && b);
  a?.rename('c.ts');
  assert.equal(p?.childByCurrent('c.ts'), a); // current key moved
  assert.equal(p?.childByCurrent('a.ts'), undefined);
  assert.equal(p?.childByInitial('a.ts'), a); // initial key preserved
  assert.equal(p?.childByCurrent('b.ts'), b); // sibling untouched
  // removeChild precision: moving b away evicts only b's entries, not c's.
  const q = tree.ensureDirAtCurrent(rel('q'));
  b?.moveTo(q);
  assert.equal(p?.childByCurrent('b.ts'), undefined);
  assert.equal(p?.childByCurrent('c.ts'), a);
  assert.equal(q.childByCurrent('b.ts'), b);
});

test('iteration is complete when two siblings share an initial name (cross-dir move)', async () => {
  const tree = buildTree(listing('P/foo.ts', 'Q/foo.ts'));
  const f = tree.findByInitialPath(rel('P/foo.ts'));
  f?.rename('bar.ts'); // P/foo.ts → P/bar.ts (vacates current name foo.ts under P)
  const g = tree.findByInitialPath(rel('Q/foo.ts'));
  const pDir = tree.findByCurrentPath(rel('P'));
  assert.ok(g && pDir);
  g?.moveTo(pDir as NonNullable<typeof pDir>, 'foo.ts'); // Q/foo.ts → P/foo.ts (same initial name as f)
  // Both must be visible: iterating the initial-name index would silently drop one.
  const files = [...tree.iterFiles()].map((n) => String(n.currentPath())).sort();
  assert.deepEqual(files, ['P/bar.ts', 'P/foo.ts']);
});

// ---- replay oracle ----------------------------------------------------------------

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function makeRepo(files: Record<string, string>): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'cm-tree-'));
  for (const [relPath, content] of Object.entries(files)) {
    const abs = path.join(dir, ...relPath.split('/'));
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, content, 'utf8');
  }
  git(dir, 'init', '-q');
  git(dir, 'config', 'user.email', 't@t.t');
  git(dir, 'config', 'user.name', 'test');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'init');
  return dir;
}

const posixDir = (p: string): string => {
  const i = p.lastIndexOf('/');
  return i < 0 ? '' : p.slice(0, i);
};
const toAbs = (root: string, relPath: string): string => path.join(root, ...relPath.split('/'));

test('replay oracle: commit-plan layout matches the tree (moved dir + renamed child + synth + edit)', async () => {
  const root = makeRepo({
    'D/x.ts': 'export const x = 1;\n',
    'D/z.ts': 'export const z = 2;\n',
    'keep.ts': 'export const k = 0;\n',
  });
  try {
    const loaded = await loadTreeFromGit(root);
    assert.ok(isOk(loaded));
    if (!isOk(loaded)) return;
    const tree = loaded.data;

    // D -> D2 (dir move); D/x.ts -> D2/y.ts (renamed child); D/z.ts carried; edit y; + synth.
    tree.findByCurrentPath(rel('D'))?.rename('D2');
    tree.findByInitialPath(rel('D/x.ts'))?.rename('y.ts');
    const edited = '// edited\nexport const x = 1;\n';
    tree.findByInitialPath(rel('D/x.ts'))?.setContent(edited);
    const d2 = tree.findByCurrentPath(rel('D2'));
    assert.ok(d2);
    const synthContent = '// fresh\nexport const n = 9;\n';
    if (d2) tree.addFileAtCurrent(d2, 'new.ts', synthContent);

    const plan = computeCommitPlan(tree);

    // Plan shape (pins explainedBy / actualOnDiskPath, not just the end layout).
    assert.deepEqual(plan.moves, [
      { from: 'D', to: 'D2', kind: 'dir' },
      { from: 'D2/x.ts', to: 'D2/y.ts', kind: 'file' },
    ]);
    assert.deepEqual(plan.newFiles, [{ path: 'D2/new.ts', content: synthContent }]);
    assert.deepEqual(plan.contentWrites, [{ path: 'D2/y.ts', content: edited }]); // moved AND edited

    // Execute the plan against the real repo.
    for (const m of plan.moves) {
      const toDir = posixDir(m.to);
      if (toDir) mkdirSync(toAbs(root, toDir), { recursive: true });
      git(root, 'mv', m.from, m.to);
    }
    for (const f of plan.newFiles) {
      const dir = posixDir(f.path);
      if (dir) mkdirSync(toAbs(root, dir), { recursive: true });
      writeFileSync(toAbs(root, f.path), f.content, 'utf8');
    }
    for (const w of plan.contentWrites) writeFileSync(toAbs(root, w.path), w.content, 'utf8');
    git(root, 'add', '-A');
    git(root, 'commit', '-q', '-m', 'moved');

    // Oracle: on-disk listing == every file node's currentPath().
    const onDisk = git(root, 'ls-files').split('\n').filter(Boolean).sort();
    const claimed = [...tree.iterFiles()].map((n) => String(n.currentPath())).sort();
    assert.deepEqual(onDisk, claimed);
    assert.deepEqual(onDisk, ['D2/new.ts', 'D2/y.ts', 'D2/z.ts', 'keep.ts']);

    // Content landed at the CURRENT paths (the moved+edited file and the synthetic file).
    assert.equal(readFileSync(toAbs(root, 'D2/y.ts'), 'utf8'), edited);
    assert.equal(readFileSync(toAbs(root, 'D2/new.ts'), 'utf8'), synthContent);
    // git preserved history across the rename of the moved dir.
    assert.match(git(root, 'log', '--follow', '--format=%s', '--', 'D2/y.ts'), /init/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
