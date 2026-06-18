// §3.5 / §19: the host's discovered-sibling and undiscovered config memos are host-lifetime, and
// content-fingerprint freshness can't see a tsconfig SET change. So a post-warm tsconfig add must
// invalidate them — or `find_unused_exports` reads an export used only from a newly-added nested
// program as `certain`-DEAD (a silent false-dead, the cardinal lie: an agent deletes a live export).
// The invalidation must be §19-safe: triggered by a cheap basename scan of the reindex changed set,
// NEVER a repo re-walk per reindex (the ls-host per-call-tree-scan hang class).
//
// (a) Integration via the real pipeline: warm → a genuinely-dead export reads `certain`; then ADD a
//     nested tsconfig importing it → the next read demotes it to `partial` and NAMES the config.
//     Oracle = a cold LS over the nested tsconfig proving the import is real (never the warm fan-out,
//     which by design doesn't search an undiscovered program; §16).
// (b) Bound/§19 via the host directly: `undiscoveredProgramLabels()` returns the SAME array
//     reference across a non-tsconfig reindex (proof it was NOT recomputed → no re-walk), and a
//     fresh one only after a tsconfig appears in the changed set.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { project } from '../helpers/project.ts';
import { coldFindReferences } from '../helpers/cold-ls.ts';
import { createTsProjectHost } from '../../src/plugins/ts/ls-host.ts';
import type { RepoRelPath } from '../../src/core/brands.ts';

type Unused = { name: string; confidence: string; note?: string };
type View = { unused: Unused[]; undiscoveredPrograms?: string[] };

// Primary `include:["src"]` EXCLUDES `packages/**` — so `usedOnlyInPkg` is genuinely dead in the
// primary program before the nested tsconfig exists (the test pins the bug only if it starts dead).
const BASE = {
  'tsconfig.json':
    '{"compilerOptions":{"strict":true,"module":"esnext","moduleResolution":"bundler"},"include":["src"]}',
  'src/lib.ts':
    'export const usedOnlyInPkg = 1;\n' + // dead until the nested program is added post-warm
    'export const usedInPrimary = 2;\n', // used within the primary program — must STAY used
  'src/app.ts':
    "import { usedInPrimary } from './lib';\nexport const useIt = () => usedInPrimary;\n",
};

test('post-warm add of a nested tsconfig invalidates the undiscovered memo — a once-dead export demotes to partial (named), never a silent false-dead; a primary-used export stays used', async () => {
  const p = await project(BASE);
  try {
    const before = await p.op('find_unused_exports', {});
    assert.ok('result' in before && before.result.ok, 'warm op succeeds');
    const beforeData = before.result.data as View;
    const beforeRow = (n: string): Unused | undefined =>
      beforeData.unused.find((u) => u.name === n);
    // Warm baseline: no nested tsconfig exists, so the export is honestly dead in every loaded
    // program AND there is no undiscovered config — a `certain`-dead.
    assert.equal(
      beforeRow('usedOnlyInPkg')?.confidence,
      'certain',
      'before the add: genuinely dead in the only program → certain',
    );
    assert.equal(beforeData.undiscoveredPrograms, undefined, 'no undiscovered config yet');
    assert.equal(beforeRow('usedInPrimary'), undefined, 'a primary-used export is not reported');

    // Post-warm: a `git checkout`-style add of a NESTED package with its own tsconfig (neither
    // adjacent to the root config nor `references`d → undiscovered) whose file imports the export.
    p.write(
      'packages/app/tsconfig.json',
      '{"compilerOptions":{"strict":true,"module":"esnext","moduleResolution":"bundler"}}',
    );
    p.write(
      'packages/app/main.ts',
      "import { usedOnlyInPkg } from '../../src/lib';\nexport const z = usedOnlyInPkg;\n",
    );
    p.commit('add nested package');

    // Independent oracle: a cold LS over the NESTED tsconfig proves the import is real — so a
    // `certain`-dead after the add would be the exact lie this fix prevents.
    assert.deepEqual(
      coldFindReferences(p.root, 'src/lib.ts', 'usedOnlyInPkg', 'packages/app/tsconfig.json'),
      ['packages/app/main.ts', 'src/lib.ts'],
      'cold ground truth: the export IS used from the newly-added undiscovered program',
    );

    // The next read drifts (freshness sees the new files), reindex carries the new tsconfig, the
    // memo is invalidated → the undiscovered floor now applies.
    const after = await p.op('find_unused_exports', {});
    assert.ok('result' in after && after.result.ok, 'post-add op succeeds');
    const afterData = after.result.data as View;
    const afterRow = (n: string): Unused | undefined => afterData.unused.find((u) => u.name === n);

    assert.equal(
      afterRow('usedOnlyInPkg')?.confidence,
      'partial',
      'after the add: demoted to partial — the silent false-dead is closed without an MCP reconnect',
    );
    assert.match(
      afterRow('usedOnlyInPkg')?.note ?? '',
      /packages\/app\/tsconfig\.json/,
      'the note names the newly-discovered undiscovered tsconfig (proof of why)',
    );
    assert.deepEqual(
      afterData.undiscoveredPrograms,
      ['packages/app/tsconfig.json'],
      'the invalidated memo recomputed to include the added config',
    );
    // Note 2 (mirrors wave-1 A used-untouched): invalidation must not OVER-demote a proven-used
    // export — `usedInPrimary` is referenced in the primary program and stays used (unreported).
    assert.equal(
      afterRow('usedInPrimary'),
      undefined,
      'a primary-used export stays used after the add — no over-demotion',
    );
  } finally {
    await p.dispose();
  }
});

test('§19 bound: undiscoveredProgramLabels() is NOT recomputed on a non-tsconfig reindex (no per-reindex re-walk); recomputed only when a tsconfig is in the changed set', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'cm-tsconfig-inval-'));
  try {
    writeFileSync(
      path.join(dir, 'tsconfig.json'),
      '{"compilerOptions":{"strict":true},"include":["src"]}',
    );
    mkdirSync(path.join(dir, 'src'), { recursive: true });
    writeFileSync(path.join(dir, 'src', 'a.ts'), 'export const a = 1;\n');
    // A nested (undiscovered) tsconfig so the memo is non-empty and the identity check is meaningful.
    mkdirSync(path.join(dir, 'packages', 'app'), { recursive: true });
    writeFileSync(path.join(dir, 'packages', 'app', 'tsconfig.json'), '{"compilerOptions":{}}');

    const host = createTsProjectHost(dir);
    try {
      const first = host.undiscoveredProgramLabels(); // computes once (the one allowed walk)
      assert.deepEqual([...first], ['packages/app/tsconfig.json'], 'memo computed correctly');

      // A reindex with NO tsconfig in the changed set must not invalidate — the array identity is
      // preserved, proving the §19-forbidden repo re-walk did not run.
      host.reindex(['src/a.ts' as RepoRelPath]);
      const second = host.undiscoveredProgramLabels();
      assert.equal(
        first,
        second,
        'same array reference — the memo was NOT recomputed (no per-reindex re-walk)',
      );

      // A reindex carrying a tsconfig DOES invalidate → a fresh computation (different reference),
      // still correct against the current tree.
      host.reindex(['packages/app/tsconfig.json' as RepoRelPath]);
      const third = host.undiscoveredProgramLabels();
      assert.notEqual(first, third, 'a tsconfig change invalidates the memo — recomputed');
      assert.deepEqual([...third], [...first], 'recomputed content still matches the current tree');
    } finally {
      host.dispose();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
