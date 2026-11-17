// The watcher event filter reads ROOT-RELATIVE paths and treats the last segment as a possible
// directory too (chokidar asks about directories before descending into them).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isIgnoredWatchPath } from '../../src/support/watch/ignored-event.ts';

test('ignored dirs are cut as the entry itself and as an ancestor; source is kept', () => {
  for (const rel of [
    'node_modules',
    '.git',
    'src/build',
    'a/node_modules/x/index.js',
    '.git/index',
  ]) {
    assert.equal(isIgnoredWatchPath(rel), true, rel);
  }
  for (const rel of ['', 'src', 'src/a.ts', 'src/builder/a.ts']) {
    assert.equal(isIgnoredWatchPath(rel), false, rel);
  }
});

test('editor temp files and paths outside the root are cut', () => {
  for (const rel of ['src/a.ts.swp', 'src/a.ts~', 'x.tmp', '..', '../other/a.ts']) {
    assert.equal(isIgnoredWatchPath(rel), true, rel);
  }
});
