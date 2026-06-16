// `samePath` (resolve-module.ts) decides whether a module ARG and an import SPECIFIER point at
// the SAME file. The two callers resolve through different paths: `resolveModuleArg`'s fast-path
// returns the arg's raw form, while `resolveSpecifier` returns TS's realpath-canonical
// `resolvedFileName`. So a symlinked path (pnpm/monorepo) or a wrong-case arg on a
// case-insensitive volume must still compare EQUAL — otherwise the i18n identity scan reports
// `moduleResolved=true, calls=[]` with no incompleteness flag: zero usages, a quiet mislead
// (bug-review, Task I). Oracle: an ACTUAL on-disk symlink — deterministic regardless of the
// host filesystem's case sensitivity.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, symlinkSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { samePath } from '../../src/plugins/ts/resolve-module.ts';

test('samePath collapses a symlink to its realpath target (the cross-resolution-form trap)', () => {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'samepath-')));
  try {
    const real = path.join(dir, 'i18n.ts');
    writeFileSync(real, 'export const t = (k: string) => k;\n');
    const link = path.join(dir, 'i18n-link.ts');
    symlinkSync(real, link); // a symlinked alias, as pnpm/monorepo layouts produce

    // The arg fast-path could hand back the symlink form while specifier resolution hands back
    // the realpath form — same file, different strings. samePath must see through it.
    assert.equal(samePath(link, real), true, 'a symlink and its target are the same file');
    assert.equal(samePath(real, link), true, 'order-independent');
    assert.equal(samePath(real, real), true, 'a path equals itself');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('samePath does NOT conflate two genuinely distinct files', () => {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'samepath-')));
  try {
    const a = path.join(dir, 'a.ts');
    const b = path.join(dir, 'b.ts');
    writeFileSync(a, '');
    writeFileSync(b, '');
    assert.equal(samePath(a, b), false, 'distinct files are never the same path');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('samePath falls back to normalize for non-existent paths (realpath would throw)', () => {
  // A specifier may resolve to a path that does not exist on disk; canonicalization must not
  // throw — it falls back to path.normalize so a clean syntactic comparison still holds.
  const ghost = path.join(tmpdir(), 'does', 'not', 'exist', 'mod.ts');
  assert.equal(samePath(ghost, `${ghost}`), true, 'identical missing paths compare equal');
  assert.equal(
    samePath(path.join(tmpdir(), 'x', '..', 'mod.ts'), path.join(tmpdir(), 'mod.ts')),
    true,
    'normalize still collapses `..` segments when realpath cannot resolve',
  );
});
