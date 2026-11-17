// A watcher that degrades while starting (the native adapter on a sync `fs.watch` throw) must read
// as degraded in status, not as an active watcher that watches nothing.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createNativeRecursiveWatcher } from '../../src/support/watch/native-recursive.ts';
import { manualClock, project } from '../helpers/project.ts';

test('a watcher degraded inside watch() is reported degraded by status', async () => {
  const p = await project(
    { 'src/a.ts': 'export const a = 1;\n' },
    {
      watcher: createNativeRecursiveWatcher(manualClock(), () => {
        throw new Error('EMFILE: too many open files');
      }),
    },
  );
  try {
    const text = await p.status();
    assert.match(text, /watcher=DEGRADED\(EMFILE: too many open files\)/);
  } finally {
    await p.dispose();
  }
});
