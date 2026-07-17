// Watchdog beacon (t-095661) — the main-thread side, unit-tested with a manual clock and a locally
// constructed SharedArrayBuffer. The SAB codec, the `isWedged` predicate, and `beacon.measure`
// under CONCURRENT (out-of-order) ops are all deterministic and thread-free here; the worker's
// real-timer lifetime is covered separately by the real-spawn smoke (a fake-clock unit can't cross
// the thread boundary).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SAB_BYTES,
  TEXT_CAP,
  viewsOf,
  writeBusy,
  writeIdle,
  readBeacon,
  isWedged,
} from '../../src/support/watchdog/beacon-sab.ts';
import { beacon, resetBeaconForTest } from '../../src/support/watchdog/beacon.ts';
import { manualClock } from '../helpers/project.ts';

test('beacon-sab: writeBusy/readBeacon round-trip + writeIdle clears', () => {
  const v = viewsOf(new SharedArrayBuffer(SAB_BYTES));
  writeBusy(v, 123456, 'op:find_usages {"name":"X"}');
  const busy = readBeacon(v);
  assert.equal(busy.busy, true);
  assert.equal(busy.startMs, 123456);
  assert.equal(busy.text, 'op:find_usages {"name":"X"}');
  assert.ok(busy.seq >= 1);

  writeIdle(v);
  assert.equal(readBeacon(v).busy, false);
});

test('beacon-sab: text is bounded to TEXT_CAP (never overflows the buffer)', () => {
  const v = viewsOf(new SharedArrayBuffer(SAB_BYTES));
  const huge = 'a'.repeat(TEXT_CAP * 3);
  writeBusy(v, 1, huge);
  const snap = readBeacon(v);
  // Ascii → 1 byte/char, so the decoded text is capped at TEXT_CAP chars — bounded, not the input.
  assert.ok(snap.text.length <= TEXT_CAP, `text ${snap.text.length} must be ≤ ${TEXT_CAP}`);
});

test('isWedged: only busy AND past-threshold reads as wedged', () => {
  const busyAt = { busy: true, startMs: 1000, seq: 1, text: 'op:x' };
  assert.equal(isWedged(busyAt, 1000 + 300_000, 300_000), true, 'exactly at threshold → wedged');
  assert.equal(isWedged(busyAt, 1000 + 299_999, 300_000), false, 'below threshold → not yet');
  assert.equal(isWedged({ ...busyAt, busy: false }, 1e12, 300_000), false, 'idle is never wedged');
  assert.equal(isWedged({ ...busyAt, startMs: 0 }, 1e12, 300_000), false, 'no start → not wedged');
});

test('beacon.measure: stamps during the op, clears after, and is inactive by default', async () => {
  resetBeaconForTest();
  // Inactive (no bind): a bare passthrough that still returns the value and never touches a buffer.
  assert.equal(await beacon.measure('op:x', { a: 1 }, () => Promise.resolve(42)), 42);

  const sab = new SharedArrayBuffer(SAB_BYTES);
  const view = viewsOf(sab);
  const clock = manualClock();
  beacon.bind(sab, clock);
  try {
    let during: ReturnType<typeof readBeacon> | undefined;
    const out = await beacon.measure('op:find_usages', { name: 'X' }, () => {
      during = readBeacon(view);
      return Promise.resolve('ok');
    });
    assert.equal(out, 'ok');
    assert.equal(during?.busy, true, 'busy while the op runs');
    assert.equal(during?.text, 'op:find_usages {"name":"X"}');
    assert.equal(readBeacon(view).busy, false, 'idle after the op returns');
  } finally {
    resetBeaconForTest();
  }
});

test('beacon.measure: CONCURRENT non-nested ops — a COMPLETED op never pins the beacon (false-wedge guard)', async () => {
  // The production case: several engines share the process-global beacon on one thread, unserialized
  // against each other, so ops complete OUT of push order. A LIFO stack would pop the WRONG crumb and
  // pin a finished op's ancient start → false wedge. This is the exact repro.
  resetBeaconForTest();
  const sab = new SharedArrayBuffer(SAB_BYTES);
  const view = viewsOf(sab);
  const clock = manualClock();
  beacon.bind(sab, clock);
  try {
    let resolveA = (): void => undefined;
    let resolveB = (): void => undefined;
    const aStart = clock.now();
    const pa = beacon.measure(
      'op:A',
      undefined,
      () =>
        new Promise<void>((r) => {
          resolveA = r;
        }),
    );
    clock.advance(1000);
    const pb = beacon.measure(
      'op:B',
      undefined,
      () =>
        new Promise<void>((r) => {
          resolveB = r;
        }),
    );

    assert.equal(readBeacon(view).text, 'op:A', 'the oldest live op fills the slot');
    assert.equal(readBeacon(view).startMs, aStart);

    // A (pushed FIRST) resolves FIRST — the non-LIFO ordering a stack mishandles.
    resolveA();
    await pa;
    const afterA = readBeacon(view);
    assert.equal(afterA.text, 'op:B', 'A removed by identity → B is now the live op');
    assert.notEqual(afterA.startMs, aStart, 'the completed op A never pins its ancient start');

    resolveB();
    await pb;
    assert.equal(readBeacon(view).busy, false, 'idle once every live op finishes');
  } finally {
    resetBeaconForTest();
  }
});

test('beacon.measure: sustained op churn PAST the threshold does not false-wedge a healthy beacon', async () => {
  resetBeaconForTest();
  const sab = new SharedArrayBuffer(SAB_BYTES);
  const view = viewsOf(sab);
  const clock = manualClock();
  beacon.bind(sab, clock);
  const threshold = 300_000;
  try {
    // 20 short ops each finishing cleanly, spanning 400s > threshold. A LIFO-corrupted beacon would
    // pin an early op's start and read wedged; the live-set beacon reads idle throughout.
    for (let i = 0; i < 20; i += 1) {
      await beacon.measure(`op:${i}`, undefined, () => Promise.resolve());
      clock.advance(20_000);
    }
    const snap = readBeacon(view);
    assert.equal(snap.busy, false, 'no op is live → not busy');
    assert.equal(isWedged(snap, clock.now(), threshold), false, 'healthy churn is never a wedge');
  } finally {
    resetBeaconForTest();
  }
});

test('beacon.measure: the OLDEST continuously-live op is the wedge candidate (a real wedge is still caught)', async () => {
  resetBeaconForTest();
  const sab = new SharedArrayBuffer(SAB_BYTES);
  const view = viewsOf(sab);
  const clock = manualClock();
  beacon.bind(sab, clock);
  const threshold = 300_000;
  try {
    let resolveStuck = (): void => undefined;
    const stuckStart = clock.now();
    const stuck = beacon.measure(
      'op:stuck',
      undefined,
      () =>
        new Promise<void>((r) => {
          resolveStuck = r;
        }),
    );
    // Short ops churn on top of the stuck one; the stuck op stays the oldest live → the slot occupant.
    for (let i = 0; i < 3; i += 1) {
      clock.advance(10_000);
      await beacon.measure(`op:short${i}`, undefined, () => Promise.resolve());
    }
    clock.advance(threshold);
    const snap = readBeacon(view);
    assert.equal(snap.text, 'op:stuck', 'the genuinely stuck op remains the slot occupant');
    assert.equal(snap.startMs, stuckStart);
    assert.equal(isWedged(snap, clock.now(), threshold), true, 'the real wedge is caught');
    resolveStuck();
    await stuck;
  } finally {
    resetBeaconForTest();
  }
});

test('beacon.measure: clears the breadcrumb even when the op throws', async () => {
  resetBeaconForTest();
  const sab = new SharedArrayBuffer(SAB_BYTES);
  const view = viewsOf(sab);
  beacon.bind(sab, manualClock());
  try {
    await assert.rejects(
      beacon.measure('op:boom', undefined, () => Promise.reject(new Error('boom'))),
      /boom/,
    );
    assert.equal(readBeacon(view).busy, false, 'a throwing op still clears (finally)');
  } finally {
    resetBeaconForTest();
  }
});
