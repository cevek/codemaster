// `verifyAfterWrite`'s readback branch (t-439159): bytes on disk that this op did not write are a
// concurrent writer's, so the verdict is `incomplete` — no recheck (it would judge foreign bytes) and
// no rollback (it would destroy them). The window between the write and the readback has no
// production seam, so the function is driven directly over a real temp dir; the ts plugin is a stub
// that records whether the LS recheck ran.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { RepoRelPath } from '../../src/core/brands.ts';
import type { TsPluginApi } from '../../src/plugins/ts/plugin.ts';
import { verifyAfterWrite } from '../../src/ops/post-apply-verify.ts';

test('verifyAfterWrite: foreign bytes at a written path → incomplete, recheck skipped', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'post-apply-'));
  try {
    writeFileSync(path.join(root, 'a.ts'), 'export const a = 2; // someone else\n');
    let rechecked = false;
    const ts = {
      reindex: () => Promise.resolve(),
      claimDivergence: () => [],
      diagnosticsAcross: () => {
        rechecked = true;
        return [];
      },
    } as unknown as TsPluginApi;
    const a = 'a.ts' as RepoRelPath;
    const verdict = await verifyAfterWrite({
      ts,
      root,
      written: [{ path: a, content: 'export const a = 1;\n' }],
      removed: [],
      touched: [a],
      gateScope: { anchor: [a], check: [a] },
      programs: ['tsconfig.json'],
      baseline: [],
      claims: { byPath: new Map(), structural: [] },
    });
    assert.equal(verdict.kind, 'incomplete');
    assert.match(verdict.kind === 'incomplete' ? verdict.reason : '', /did not write at a\.ts/);
    assert.equal(rechecked, false, 'no recheck over bytes this op did not write');

    writeFileSync(path.join(root, 'a.ts'), 'export const a = 1;\n');
    const matching = await verifyAfterWrite({
      ts,
      root,
      written: [{ path: a, content: 'export const a = 1;\n' }],
      removed: [],
      touched: [a],
      gateScope: { anchor: [a], check: [a] },
      programs: ['tsconfig.json'],
      baseline: [],
      claims: { byPath: new Map(), structural: [] },
    });
    assert.equal(matching.kind, 'verified', 'the same call with our bytes on disk rechecks');
    assert.equal(rechecked, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
