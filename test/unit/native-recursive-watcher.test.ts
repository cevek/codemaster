// The native recursive watcher adapter driven through its injected `watch` function, so the event
// filter, the absolute-path join, the debounce and the degrade paths run on every OS (CI is Linux,
// where production picks chokidar instead).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'node:path';
import {
  createNativeRecursiveWatcher,
  type RecursiveWatchFn,
} from '../../src/support/watch/native-recursive.ts';
import { manualClock } from '../helpers/project.ts';

interface FakeWatch {
  watchFn: RecursiveWatchFn;
  emit(filename: string | null): void;
  fail(error: Error): void;
  closed(): number;
}

function fakeWatch(): FakeWatch {
  let onEvent: ((f: string | null) => void) | undefined;
  let onError: ((e: unknown) => void) | undefined;
  let closes = 0;
  return {
    watchFn: (_root, cb) => {
      onEvent = cb;
      return {
        on: (_event, cb2) => {
          onError = cb2;
        },
        close: () => {
          closes += 1;
        },
      };
    },
    emit: (f) => onEvent?.(f),
    fail: (e) => onError?.(e),
    closed: () => closes,
  };
}

function recorder(): { batches: string[][]; degraded: string[] } & {
  events: { onChanged(p: readonly string[]): void; onDegraded(r: string): void };
} {
  const batches: string[][] = [];
  const degraded: string[] = [];
  return {
    batches,
    degraded,
    events: {
      onChanged: (p) => batches.push([...p]),
      onDegraded: (r) => degraded.push(r),
    },
  };
}

// The root sits under a `build/` ancestor: an ignore check over the ABSOLUTE path would drop every
// event of this repo.
const ROOT = path.join(path.sep, 'home', 'me', 'build', 'proj');

test('source events reach onChanged as absolute paths, junk and unnamed events do not', () => {
  const clock = manualClock();
  const fake = fakeWatch();
  const rec = recorder();
  createNativeRecursiveWatcher(clock, fake.watchFn).watch(ROOT, rec.events);
  fake.emit(path.join('src', 'a.ts'));
  fake.emit(path.join('node_modules', 'x', 'index.js'));
  fake.emit(path.join('.git', 'index'));
  fake.emit(path.join('src', 'a.ts.swp'));
  fake.emit(null);
  fake.emit(path.join('src', 'b.ts'));
  fake.emit(path.join('src', 'a.ts'));
  assert.deepEqual(rec.batches, [], 'debounced: nothing before the window closes');
  clock.advance(1_000);
  assert.deepEqual(rec.batches, [[path.join(ROOT, 'src', 'a.ts'), path.join(ROOT, 'src', 'b.ts')]]);
  assert.deepEqual(rec.degraded, []);
});

test('a watch that throws at start degrades and still returns a handle', async () => {
  const rec = recorder();
  const handle = createNativeRecursiveWatcher(manualClock(), () => {
    throw new Error('EMFILE: too many open files');
  }).watch(ROOT, rec.events);
  // `undefined` would read as watcher=off and overwrite the degraded state.
  assert.notEqual(handle, undefined);
  assert.deepEqual(rec.degraded, ['EMFILE: too many open files']);
  await handle?.close();
});

test('a watcher error degrades once, closes the native handle and drops later events', () => {
  const clock = manualClock();
  const fake = fakeWatch();
  const rec = recorder();
  createNativeRecursiveWatcher(clock, fake.watchFn).watch(ROOT, rec.events);
  fake.emit('pending.ts');
  fake.fail(new Error('boom'));
  fake.fail(new Error('again'));
  fake.emit('late.ts');
  clock.advance(1_000);
  assert.deepEqual(rec.degraded, ['boom']);
  assert.equal(fake.closed(), 1);
  assert.deepEqual(rec.batches, []);
});
