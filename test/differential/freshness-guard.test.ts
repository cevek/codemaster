// §1 never-hang — the per-op freshness walk must not re-scan the tree on every call. On a
// non-git root the guard falls back to an mtime-walk; re-walking a (possibly huge / foreign)
// tree per op is itself "per-call work that scales with repo size" (§1). These tests pin the
// two guarantees with an injected walk seam (a counter) + a manual clock:
//   (c) N ops within the TTL coalesce into ONE walk; past the TTL a walk runs again.
//   (d) a GIT root never touches walkFiles at all (checkGit answers) — byte-unchanged path.
// Oracle: the injected walk counter is ground truth for how many times the tree was scanned.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { project, manualClock } from '../helpers/project.ts';
import { createDebugSystem } from '../../src/support/debug/system.ts';
import { createFreshnessGuard } from '../../src/daemon/freshness.ts';
import { walkFiles, type WalkRunner } from '../../src/support/fs/walk.ts';
import { fail } from '../../src/common/result/construct.ts';
import type { GitRunner } from '../../src/support/git/run.ts';

/** A walk seam that delegates to the real bounded walk but counts every invocation. */
function countingWalk(): { walk: WalkRunner; calls: () => number } {
  let calls = 0;
  return {
    walk: (root, options) => {
      calls++;
      return walkFiles(root, options);
    },
    calls: () => calls,
  };
}

/** A git runner that always fails — forces the guard onto the mtime-walk path deterministically,
 *  without depending on whether the tmp dir happens to be inside a git checkout. */
const noGit: GitRunner = () => Promise.resolve(fail({ tool: 'git', message: 'no git (injected)' }));

test('(c) §1: per-op freshness re-walk is coalesced — one walk across an op burst within the TTL', async () => {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'cm-fresh-')));
  try {
    writeFileSync(path.join(dir, 'a.ts'), 'export const X = 1;\n');
    const clock = manualClock();
    const debug = createDebugSystem(clock);
    const spy = countingWalk();
    const guard = createFreshnessGuard(dir, clock, debug, noGit, spy.walk);

    // A burst of ops at the same instant: the first seeds the baseline, the rest debounce-hit.
    for (let i = 0; i < 5; i++) await guard.check();
    assert.equal(spy.calls(), 1, 'five ops within the TTL scanned the tree exactly once');

    // Past the TTL the debounce expires — freshness is re-verified, never permanently cached.
    clock.advance(1001);
    await guard.check();
    assert.equal(spy.calls(), 2, 'a call past the TTL re-walks (bounded staleness, not a cache)');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('(d) §1: a git root never calls walkFiles — checkGit answers, the git path is untouched', async () => {
  const p = await project({ 'src/a.ts': 'export const X = 1;\n' });
  try {
    const clock = manualClock();
    const debug = createDebugSystem(clock);
    const spy = countingWalk();
    // Real `runGit` default (p.root is a real git fixture) + the walk spy.
    const guard = createFreshnessGuard(p.root, clock, debug, undefined, spy.walk);

    for (let i = 0; i < 5; i++) await guard.check();
    assert.equal(spy.calls(), 0, 'a git root resolves freshness via git — walkFiles never runs');
  } finally {
    await p.dispose();
  }
});
