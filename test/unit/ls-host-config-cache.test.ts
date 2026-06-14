// Hang guard (the backoffice2 incident): `ls-host`'s `getCompilationSettings` MUST return the
// tsconfig parse from cache, never re-run `parseJsonConfigFileContent` — which recursively
// directory-scans the whole project. The LS calls `getCompilationSettings` on every
// synchronize / module-resolution pass, so a per-call re-parse is O(LS-calls × whole-tree-scan)
// = an unbounded hang on a large repo (300+ tests over tiny fixtures never exposed it — each
// re-scan was instant). The oracle: count whole-tree directory scans of the project root (what
// the config glob runs) and assert `getProgram()` adds ZERO after construction.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import ts from 'typescript';
import { createTsProjectHost } from '../../src/plugins/ts/ls-host.ts';

test('LS host caches the tsconfig parse — getProgram does NOT re-glob the tree per call (hang guard)', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'cm-lshost-'));
  const orig = ts.sys.readDirectory;
  let rootScans = 0; // scans of the project root == the config glob `parseJsonConfigFileContent` runs
  ts.sys.readDirectory = ((p: string, ...rest: unknown[]) => {
    if (path.resolve(p) === path.resolve(dir)) rootScans++;
    return (orig as (...a: unknown[]) => readonly string[])(p, ...rest);
  }) as typeof orig;
  try {
    writeFileSync(path.join(dir, 'tsconfig.json'), '{"compilerOptions":{"strict":true}}');
    writeFileSync(path.join(dir, 'a.ts'), 'export const a = 1;\nexport const b = a + 1;\n');

    const host = createTsProjectHost(dir);
    const afterConstruct = rootScans; // construction parses the config once (the one allowed glob)

    // Build the program and re-synchronize several times — exactly what drives repeated
    // getCompilationSettings calls. With the bug each one re-globs the root; cached → none do.
    host.service.getProgram();
    host.service.getNavigateToItems('a', 10, undefined, true);
    host.service.getProgram();

    assert.equal(
      rootScans,
      afterConstruct,
      `tsconfig re-globbed ${rootScans - afterConstruct}× after construction — getCompilationSettings must serve the cached parse (this re-glob-per-call was the backoffice2 hang)`,
    );
    host.dispose();
  } finally {
    ts.sys.readDirectory = orig;
    rmSync(dir, { recursive: true, force: true });
  }
});
