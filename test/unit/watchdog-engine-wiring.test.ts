// Watchdog engine wiring (t-095661). Every other test runs with the beacon INACTIVE (installed only
// from bin.ts), so `beacon.measure` is a bare passthrough and the engine wrap sites are never
// exercised — deleting a wrap or mislabelling it would fail nothing. This test binds an active
// beacon, runs a real op through the engine, and asserts the op's breadcrumb reached the buffer:
// the one guard that the `runOne` wrap (and its hand-edited parens) actually stamps what it claims.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { project } from '../helpers/project.ts';
import { systemClock } from '../../src/common/async/clock.ts';
import { beacon, resetBeaconForTest } from '../../src/support/watchdog/beacon.ts';
import { SAB_BYTES, viewsOf, readBeacon } from '../../src/support/watchdog/beacon-sab.ts';

const FILES = {
  'tsconfig.json': '{"compilerOptions":{"strict":true}}',
  'src/x.ts': 'export const x = 1;\n',
};

test('engine wiring: an active beacon receives the op breadcrumb, then returns idle', async () => {
  const p = await project(FILES);
  resetBeaconForTest();
  const sab = new SharedArrayBuffer(SAB_BYTES);
  const view = viewsOf(sab);
  beacon.bind(sab, systemClock);
  try {
    const before = readBeacon(view).seq;
    const result = await p.op('find_definition', { name: 'x' });
    assert.ok(!('error' in result), 'the op resolved (a dispatch error would skip the measure)');

    const after = readBeacon(view);
    // `writeIdle` clears only the busy flag, so the LAST breadcrumb text persists — it must name the
    // op that just ran (runOne is the final measure in a request, after freshness + any spawn init).
    assert.ok(after.seq > before, 'the engine stamped ≥1 breadcrumb — measure actually fired');
    assert.match(after.text, /^op:find_definition/, 'the runOne wrap carries the op label');
    assert.equal(after.busy, false, 'the beacon is idle once the op completes');
  } finally {
    resetBeaconForTest();
    await p.dispose();
  }
});
