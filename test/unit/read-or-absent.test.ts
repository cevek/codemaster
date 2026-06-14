// Unit test for support/fs/readTextOrAbsent — oracle = the files/dirs we just made. The
// three outcomes must stay distinct: ENOENT is `absent` (a watcher race), a real IO error
// (a directory → EISDIR) is `error`, an ordinary file is `text`. Conflating error with
// absent is the silent-stale lie the helper exists to prevent (§3.6).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { readTextOrAbsent } from '../../src/support/fs/read-or-absent.ts';

test('readTextOrAbsent: text / absent / error are distinct outcomes', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'cm-roa-'));
  try {
    writeFileSync(path.join(root, 'a.txt'), 'hello');
    mkdirSync(path.join(root, 'adir'));

    const text = readTextOrAbsent(root, 'a.txt');
    assert.deepEqual(text, { kind: 'text', text: 'hello' });

    const absent = readTextOrAbsent(root, 'missing.txt');
    assert.deepEqual(absent, { kind: 'absent' }, 'ENOENT is absence, not an error');

    // A directory read throws EISDIR — a real IO error, reported, never swallowed as absent.
    const err = readTextOrAbsent(root, 'adir');
    assert.equal(err.kind, 'error', 'a non-ENOENT IO failure is surfaced as error');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
