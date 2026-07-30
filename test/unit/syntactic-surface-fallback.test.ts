// t-810757, the arms the end-to-end path cannot reach: what the non-git syntactic surface does when
// the WALK itself fails or comes back bounded. Driven through the `SurfaceSeams` walk seam (§16:
// fault through a seam, never by breaking the host) — a real unreadable root is not reproducible
// across platforms, and "the walk hit its entry cap" needs a tree nobody should build in a test.
//
// ORACLE = the walk's own reported outcome, compared against what the surface then claims. The rule
// under test is one-directional and absolute: the surface may narrow the CLAIM to match the walk, and
// may never widen it. A failed walk is a failure; a bounded walk is an answer that says it is bounded.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { fail, ok, partial } from '../../src/common/result/construct.ts';
import type { WalkedFile } from '../../src/support/fs/walk.ts';
import { createSyntacticCache, surfaceProvenance } from '../../src/plugins/ts/syntactic-cache.ts';
import { surfaceSources } from '../../src/plugins/ts/syntactic-surface.ts';
import { surfaceModeNote } from '../../src/plugins/ts/syntactic-scope.ts';
import type { RepoRelPath } from '../../src/core/brands.ts';

/** A non-git directory holding one real source file — the walk seam still reports paths, but the
 *  file must exist for the surface to read and parse it. */
function bareDir(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'cm-surface-'));
  mkdirSync(path.join(root, 'src'), { recursive: true });
  writeFileSync(path.join(root, 'src/a.ts'), 'export const one = 1;\n');
  return root;
}

/** What a walk of `bareDir()` reports: the one real source file, so the surface can read + parse it.
 *  mtime is far in the past — the racy-clean escalation must NOT fire and hash it here. */
function walked(): WalkedFile[] {
  return [{ path: 'src/a.ts' as RepoRelPath, size: 21, mtimeMs: 1_000 }];
}

test('a walk that FAILS fails the surface — never an empty catalogue that reads as an empty repo', () => {
  const root = bareDir();
  try {
    const res = surfaceSources(root, createSyntacticCache(), {
      walk: () => fail({ tool: 'fs', message: 'EACCES: permission denied' }),
    });
    assert.equal(res.ok, false, 'an unlistable root is a failure, not an absence');
    assert.equal('data' in res && res.data !== undefined, false, 'no data may accompany it');
    assert.match(
      res.ok ? '' : res.failure.message,
      /EACCES: permission denied/,
      'the cause survives',
    );
    assert.match(
      res.ok ? '' : res.failure.message,
      /git is unavailable/,
      'and so does why we walked',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a BOUNDED walk answers, and the answer carries the bound', () => {
  const root = bareDir();
  const cache = createSyntacticCache();
  try {
    const res = surfaceSources(root, cache, {
      walk: () =>
        partial(walked(), {
          tool: 'fs',
          message: 'walk incomplete: 3 symlink(s) not followed',
        }),
    });
    assert.equal(res.ok, true, 'files were listed, so there is a real answer');
    assert.equal(res.ok && res.data.sources.size, 1);

    const provenance = surfaceProvenance(cache);
    assert.equal(provenance?.origin, 'walk');
    assert.equal(provenance?.incomplete, 'walk incomplete: 3 symlink(s) not followed');
    // The bound must reach the AGENT, not just the struct — an incomplete scan that renders like a
    // complete one is the §3.4 lie this carries.
    const note = surfaceModeNote(provenance);
    assert.match(note ?? '', /INCOMPLETE SCAN/);
    assert.match(note ?? '', /3 symlink\(s\) not followed/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a clean walk is an ordinary answer: origin walk, no bound claimed', () => {
  const root = bareDir();
  const cache = createSyntacticCache();
  try {
    const res = surfaceSources(root, cache, { walk: () => ok(walked()) });
    assert.equal(res.ok, true);
    const provenance = surfaceProvenance(cache);
    assert.equal(provenance?.origin, 'walk');
    assert.equal(provenance?.incomplete, undefined, 'nothing was cut, so nothing is claimed cut');
    const note = surfaceModeNote(provenance);
    assert.doesNotMatch(note ?? '', /INCOMPLETE SCAN/);
    assert.match(note ?? '', /SURFACE = FILESYSTEM WALK/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('an unestablished origin prints its own line — silence never stands in for the default', () => {
  // No surface memoized: the op must not let the absent line read as "the git default held".
  assert.equal(surfaceProvenance(createSyntacticCache()), undefined);
  const note = surfaceModeNote(undefined);
  assert.match(note ?? '', /SURFACE ORIGIN NOT ESTABLISHED/);
  // …while the established default is the ONE state that prints nothing (its terms are in the
  // static scope prose, so a line there would be a standing token tax restating the norm).
  assert.equal(surfaceModeNote({ origin: 'git' }), undefined);
});
