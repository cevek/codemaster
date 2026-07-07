// Correction #2 / §19 cadence guard: the `.gitignore` junk set drives off a bounded SYNC git call,
// which is safe ONLY because it fires ONCE per structural reindex (memoized), never per-op/per-file
// — the exact shape of this repo's worst documented hang (ls-host re-globbing per
// getCompilationSettings). We inject a COUNTING computeIgnored seam and assert the count: unchanged
// across many reads, +1 per structural reindex. (A per-op regression here would be an unbounded hang
// on a large repo that tiny-fixture correctness tests can't catch — so we count, never just assert.)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { RepoRelPath } from '../../src/core/brands.ts';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { createTsProjectHost } from '../../src/plugins/ts/ls-host.ts';

test('git-ignored set is computed ONCE per structural reindex, never per read op', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'cm-ignore-cadence-'));
  let calls = 0;
  try {
    writeFileSync(path.join(dir, 'tsconfig.json'), '{"compilerOptions":{"strict":true}}');
    writeFileSync(path.join(dir, 'a.ts'), 'export const a = 1;\nexport const b = a + 1;\n');

    const host = createTsProjectHost(dir, undefined, {
      computeIgnored: () => {
        calls++;
        return new Set<string>();
      },
    });
    // Construction globs the primary file list once → exactly one compute (the injected counting
    // fake IS the observable — no production-interface method needed).
    assert.equal(calls, 1, 'construction computes the junk set once');

    // A burst of READ ops (what an agent session actually does) must add ZERO git calls.
    host.service.getProgram();
    host.service.getNavigateToItems('a', 10, undefined, true);
    host.service.getProgram();
    host.fileNames();
    host.service.getNavigateToItems('b', 10, undefined, true);
    assert.equal(calls, 1, 'reads never recompute the junk set (no per-op git call)');

    // A STRUCTURAL reindex (a new .ts file) re-globs the file list → exactly one more compute.
    writeFileSync(path.join(dir, 'c.ts'), 'export const c = 3;\n');
    host.reindex(['c.ts'] as RepoRelPath[]);
    host.service.getProgram();
    assert.equal(calls, 2, 'a structural reindex recomputes exactly once');

    // A NON-structural reindex (an edit to an existing file) triggers no re-glob → no recompute.
    host.reindex(['a.ts'] as RepoRelPath[]);
    host.service.getProgram();
    host.service.getNavigateToItems('a', 10, undefined, true);
    assert.equal(calls, 2, 'a content-only reindex does not recompute');

    host.dispose();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
