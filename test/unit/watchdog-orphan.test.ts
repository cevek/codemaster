// Watchdog orphan detection + main-loop poll (backstop 2, t-095661). Pure predicate + a fake-clock
// poll loop with an injected existence probe — deterministic, no real process/thread involved.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isOrphaned,
  processAlive,
  startOrphanPoll,
} from '../../src/support/watchdog/orphan-poll.ts';
import { manualClock } from '../helpers/project.ts';

test('processAlive: self is alive, a bogus pid is not', () => {
  assert.equal(processAlive(process.pid), true);
  assert.equal(processAlive(999_999), false);
});

test('isOrphaned: orphaned iff the spawning parent no longer exists', () => {
  assert.equal(
    isOrphaned(4321, () => true),
    false,
    'parent alive → not orphaned',
  );
  assert.equal(
    isOrphaned(4321, () => false),
    true,
    'parent gone → orphaned',
  );
});

test('startOrphanPoll: fires onOrphan ONCE when the parent dies, then stops', () => {
  const clock = manualClock();
  let alive = true;
  let fired = 0;
  startOrphanPoll({
    clock,
    parentAtStart: 4321,
    pollMs: 5000,
    onOrphan: () => {
      fired += 1;
    },
    probe: () => alive,
  });

  clock.advance(5000);
  assert.equal(fired, 0, 'parent alive → no fire, reschedules');
  clock.advance(5000);
  assert.equal(fired, 0, 'still alive');

  alive = false;
  clock.advance(5000);
  assert.equal(fired, 1, 'parent gone → fires');
  clock.advance(50_000);
  assert.equal(fired, 1, 'poll stopped after firing — never fires twice');
});

test('startOrphanPoll: stop() cancels before any fire', () => {
  const clock = manualClock();
  let fired = 0;
  const stop = startOrphanPoll({
    clock,
    parentAtStart: 4321,
    pollMs: 5000,
    onOrphan: () => {
      fired += 1;
    },
    probe: () => false, // parent already gone
  });
  stop();
  clock.advance(50_000);
  assert.equal(fired, 0, 'stopped poll never fires');
});
