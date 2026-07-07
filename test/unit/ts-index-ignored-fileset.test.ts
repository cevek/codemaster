// t-019044 — the TS program file-set must NEVER index build output, nested VCS checkouts, or a
// dir the project's own `.gitignore` declares junk, however loose the tsconfig `include`. Without
// this a minified `dist/*.js` bundle surfaces as a project symbol and a `.claude/worktrees` copy
// phantom-doubles every declaration (`find_usages` → an "ambiguous" failure) — the never-lie
// violation this closes. Two independent excluders (proven distinct here):
//   • name-based (§10 set) — the reliable excluder for a nested worktree the OUTER `.gitignore`
//     can't see across the working-tree boundary;
//   • git-ignore-based — the excluder for an arbitrary main-tree `generated/` dir no name covers.
// Oracle: git's own ignore verdict + the §10 convention (both independent of codemaster).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { project, type TestProject } from '../helpers/project.ts';
import { createTsProjectHost } from '../../src/plugins/ts/ls-host.ts';
import type { OpResult } from '../../src/ops/contracts.ts';

function matchNames(r: OpResult): string[] {
  assert.ok('result' in r && r.result.ok, `expected success, got ${JSON.stringify(r)}`);
  const d = r.result.data as { matches: { name?: string }[] };
  return d.matches.map((m) => m.name ?? '');
}

test('name-based exclusion: build output + a nested worktree copy never index (even tracked, no .gitignore)', async () => {
  const p: TestProject = await project({
    // A loose config that globs everything, INCLUDING an explicit reach into `.claude` (TS's own
    // wildcard skips dotdirs, so we force the worktree copy into the glob to prove B removes it).
    'tsconfig.json':
      '{"compilerOptions":{"allowJs":true,"strict":false},"include":["**/*",".claude/worktrees/**/*"]}',
    'src/real.ts': 'export const RealSym = 1;\n',
    'dist/bundle.js': 'export const distMangled = 1;\n',
    '.claude/worktrees/wt/copy.ts': 'export const WorktreeDup = 1;\n',
  });
  try {
    assert.deepEqual(matchNames(await p.op('search_symbol', { query: 'RealSym' })), ['RealSym']);
    assert.deepEqual(
      matchNames(await p.op('search_symbol', { query: 'distMangled' })),
      [],
      'dist/ build output must not index',
    );
    assert.deepEqual(
      matchNames(await p.op('search_symbol', { query: 'WorktreeDup' })),
      [],
      '.claude/worktrees copy must not index',
    );
  } finally {
    await p.dispose();
  }
});

test('git-ignore exclusion: an arbitrary gitignored dir no name-set covers is still dropped (§10)', async () => {
  const p: TestProject = await project({
    '.gitignore': 'secret-generated/\n',
    'tsconfig.json': '{"compilerOptions":{"strict":true},"include":["**/*"]}',
    'src/hand.ts': 'export const HandSym = 1;\n',
    'secret-generated/api.ts': 'export const GenSym = 1;\n', // untracked + ignored → junk
  });
  try {
    assert.deepEqual(matchNames(await p.op('search_symbol', { query: 'HandSym' })), ['HandSym']);
    assert.deepEqual(
      matchNames(await p.op('search_symbol', { query: 'GenSym' })),
      [],
      'a gitignored dir (not in the name set) must be excluded by the git-ignore mechanism',
    );
  } finally {
    await p.dispose();
  }
});

test('correction #1: an untracked-NOT-ignored file still indexes; an untracked-IGNORED one does not', async () => {
  const p: TestProject = await project({
    '.gitignore': 'ignored-dir/\n',
    'tsconfig.json': '{"compilerOptions":{"strict":true},"include":["**/*"]}',
    'src/base.ts': 'export const Base = 1;\n',
  });
  try {
    // The create-then-query workflow: write a fresh source file, DON'T commit it (untracked, not
    // ignored) — the read-time freshness backstop reindexes and it MUST resolve.
    p.write('src/fresh.ts', 'export const FreshSym = 1;\n');
    assert.deepEqual(
      matchNames(await p.op('search_symbol', { query: 'FreshSym' })),
      ['FreshSym'],
      'a freshly-written untracked-not-ignored file must index (ignore-semantics, NOT tracked-only)',
    );
    // …while an untracked-and-IGNORED file stays out.
    p.write('ignored-dir/junk.ts', 'export const JunkSym = 1;\n');
    assert.deepEqual(matchNames(await p.op('search_symbol', { query: 'JunkSym' })), []);
  } finally {
    await p.dispose();
  }
});

test('no phantom-double: a gitignored dist/ copy does not make find_usages(name) "ambiguous"', async () => {
  const p: TestProject = await project({
    '.gitignore': 'dist/\n',
    'tsconfig.json': '{"compilerOptions":{"allowJs":true},"include":["**/*"]}',
    'src/widget.ts': 'export function Widget() { return 1; }\nexport const w = Widget();\n',
    'dist/widget.js': 'export function Widget() { return 1; }\n', // build copy — must not exist to the LS
  });
  try {
    const r = await p.op('find_usages', { name: 'Widget' });
    assert.ok(
      'result' in r && r.result.ok,
      `find_usages(Widget) must resolve one declaration, not fail ambiguous: ${JSON.stringify(r)}`,
    );
    const d = r.result.data as { definition?: { id?: string } };
    assert.match(d.definition?.id ?? '', /src\/widget\.ts/, 'the sole definition is the src one');
  } finally {
    await p.dispose();
  }
});

test('un-ignoring a dir (a `.gitignore` edit) re-globs the newly-un-ignored files back in', async () => {
  const p: TestProject = await project({
    '.gitignore': 'generated/\n',
    'tsconfig.json': '{"compilerOptions":{"strict":true},"include":["**/*"]}',
    'src/base.ts': 'export const Base = 1;\n',
    'generated/api.ts': 'export const GenSym = 1;\n',
  });
  try {
    assert.deepEqual(
      matchNames(await p.op('search_symbol', { query: 'GenSym' })),
      [],
      'ignored first',
    );
    // Remove the ignore rule — a lone `.gitignore` edit must be treated as structural so the
    // now-un-ignored file is re-globbed IN (else it stays dropped until an unrelated source change).
    p.write('.gitignore', '\n');
    assert.deepEqual(
      matchNames(await p.op('search_symbol', { query: 'GenSym' })),
      ['GenSym'],
      'un-ignored file must re-index after the .gitignore edit',
    );
  } finally {
    await p.dispose();
  }
});

test('an above-root `include` file is NEVER dropped — even under an ignored-named ancestor dir', () => {
  // BLOCK-1 regression: a monorepo package tsconfig with `include: ["../shared/**"]` emits
  // above-root absolute fileNames. The name-segment exclusion must NOT run on those (an absolute
  // path under `…/build/…` would false-match `build` and silently drop every shared file — a
  // completeness lie). Oracle: the program's own file set must still contain the shared file.
  const base = mkdtempSync(path.join(tmpdir(), 'cm-aboveroot-'));
  try {
    // Force an ignored-named ancestor segment (`build`) into the checkout path.
    const root = path.join(base, 'build', 'proj');
    mkdirSync(path.join(root, 'src'), { recursive: true });
    mkdirSync(path.join(base, 'build', 'shared'), { recursive: true });
    writeFileSync(
      path.join(root, 'tsconfig.json'),
      '{"compilerOptions":{"strict":true},"include":["src/**/*","../shared/**/*"]}',
    );
    writeFileSync(path.join(root, 'src', 'a.ts'), 'export const A = 1;\n');
    writeFileSync(path.join(base, 'build', 'shared', 's.ts'), 'export const Shared = 1;\n');

    const host = createTsProjectHost(root, undefined, { computeIgnored: () => new Set() });
    const files = host.fileNames();
    assert.ok(
      files.some((f) => f.endsWith('/shared/s.ts')),
      `above-root shared file dropped from the program: ${JSON.stringify(files)}`,
    );
    host.dispose();
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
