// The out-of-root gate of the t-167395 discovery-prune coverage test (`coversInRootSurface`). A
// `references:[{path:'../shared'}]` sibling loads files the git-at-root surface can't see, so if any
// loaded program has a file outside root the prune MUST stay off (an undisclosed out-of-root drop
// would be a §3.6 lie). The single-root VFS fixture (`project()`) can't place a program's files
// outside root, so this is a focused unit test over a real temp git repo + a real primary program:
// the ONLY difference between the covered (prune-ON) and gated (prune-OFF) assertions is the
// presence of an out-of-root sibling — so it isolates the gate, not the empty-surface fallback.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import ts from 'typescript';
import { coversInRootSurface } from '../../src/plugins/ts/discovery-prune.ts';
import type { TsProgram } from '../../src/plugins/ts/program/queryable-program.ts';

const service = (root: string): ts.LanguageService =>
  ts.createLanguageService({
    getScriptFileNames: () => [],
    getScriptVersion: () => '1',
    getScriptSnapshot: () => undefined,
    getCurrentDirectory: () => root,
    getCompilationSettings: () => ({}),
    getDefaultLibFileName: (o) => ts.getDefaultLibFilePath(o),
    fileExists: () => false,
    readFile: () => undefined,
  });

function fakeProgram(
  svc: ts.LanguageService,
  files: readonly string[],
  program: ts.Program | undefined,
): TsProgram {
  return {
    service: svc,
    label: 'x',
    getProgram: () => program,
    fileNames: () => files,
    containsFile: () => false,
  };
}

test('out-of-root gate isolates from coverage: covered without a sibling, NOT-covered with an out-of-root one', () => {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'cm-prune-')));
  try {
    mkdirSync(path.join(root, 'src'));
    const aAbs = path.join(root, 'src', 'a.ts');
    writeFileSync(aAbs, 'export const A = 1;\n');
    const git = (...args: string[]): void => void execFileSync('git', args, { cwd: root });
    git('init', '-q');
    git('config', 'user.email', 't@t');
    git('config', 'user.name', 't');
    git('add', '-A');
    git('commit', '-qm', 'x');

    const posix = (p: string): string => p.split(path.sep).join('/');
    const rootPosix = posix(root);
    const relOf = (abs: string): string => {
      const pfx = `${rootPosix}/`;
      const p = posix(abs);
      return p.startsWith(pfx) ? p.slice(pfx.length) : p;
    };
    const host = { relOf };
    const svc = service(root);
    const program = ts.createProgram([aAbs], {});
    const primary = fakeProgram(svc, [`${rootPosix}/src/a.ts`], program);

    // Baseline: primary alone covers the in-root git surface (src/a.ts) → prune ON.
    assert.equal(
      coversInRootSurface([primary], host, rootPosix),
      true,
      'primary covers the in-root surface → prune eligible',
    );

    // Add an out-of-root sibling (a `../shared` reference): coverage is otherwise unchanged, only the
    // gate flips it OFF. If the gate were removed this would still be TRUE (the surface is unchanged),
    // so a green here proves the gate — not the empty-surface fallback — is doing the work.
    const sibling = fakeProgram(svc, ['/tmp/other-repo/shared/x.ts'], undefined);
    assert.equal(
      coversInRootSurface([primary, sibling], host, rootPosix),
      false,
      'an out-of-root program file disables the prune (avoids an undisclosed out-of-root drop, §3.6)',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('coverage declines when a primary is unbuilt (getProgram undefined)', () => {
  const root = '/tmp/cm-fake-root';
  const primary = fakeProgram(service(root), [`${root}/src/a.ts`], undefined);
  assert.equal(
    coversInRootSurface([primary], { relOf: (a) => a }, root),
    false,
    'no primary program → no prune',
  );
});
