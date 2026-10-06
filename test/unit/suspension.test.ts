// A wall-clock window that spans a darwin system sleep (t-833715): the kernel's last sleep/wake
// pair, its overlap with a call, the shared phrasing, and the usage record's `suspendedMs`.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { suspendedWithin } from '../../src/common/suspension/overlap.ts';
import { suspensionNote } from '../../src/common/suspension/describe.ts';
import { parseSleepWake } from '../../src/support/suspension/last-suspension.ts';
import { withCallTelemetry, SUSPENSION_PROBE_MIN_MS } from '../../src/mcp/call-telemetry.ts';
import type { UsageLogEntry, UsageLogger } from '../../src/support/usage-log/entry.ts';
import { manualClock } from '../helpers/project.ts';

// Captured from `sysctl -n kern.sleeptime kern.waketime` on the incident machine.
const SYSCTL_OUT =
  '{ sec = 1791272413, usec = 889407 } Tue Oct  6 12:40:13 2026\n' +
  '{ sec = 1791272862, usec = 624696 } Tue Oct  6 12:47:42 2026\n';
const INCIDENT = { sleptAtMs: 1791272413889, wokeAtMs: 1791272862624 };

test('parseSleepWake reads the last cycle off real sysctl output, and refuses what it cannot read', () => {
  assert.deepEqual(parseSleepWake(SYSCTL_OUT), INCIDENT);
  assert.equal(parseSleepWake(''), undefined);
  assert.equal(parseSleepWake('{ sec = 0, usec = 0 } x\n{ sec = 5, usec = 0 } y\n'), undefined);
  assert.equal(
    parseSleepWake('{ sec = 9, usec = 0 } x\n{ sec = 5, usec = 0 } y\n'),
    undefined,
    'a wake before its sleep is not a completed suspension',
  );
});

test('suspendedWithin: full, partial and disjoint windows', () => {
  const s = { sleptAtMs: 100, wokeAtMs: 200 };
  assert.equal(suspendedWithin(50, 300, s), 100);
  assert.equal(suspendedWithin(150, 300, s), 50);
  assert.equal(suspendedWithin(50, 120, s), 20);
  assert.equal(suspendedWithin(200, 300, s), 0);
  assert.equal(suspendedWithin(0, 100, s), 0);
});

test('suspensionNote: the incident window explains the overrun; a long awake window does not', () => {
  const start = 1791272402468;
  const end = 1791272862966;
  const note = suspensionNote(start, end, INCIDENT, 150_000);
  assert.ok(
    note !== undefined &&
      /slept ≥448s of this 460s window \(woke 2026-10-06T07:47:42Z\)/.test(note),
    note,
  );
  assert.match(note, /awake ≤12s/);
  assert.match(note, /retry is not expected to time out/);
  // Same sleep, but 200 s awake around it — over the 150 s budget: the sleep is stated, not blamed.
  const stated = suspensionNote(start - 200_000, end, INCIDENT, 150_000);
  assert.ok(stated !== undefined && !/retry/.test(stated), stated);
  // A one-second sleep early in a full 150 s window: the deadline ran out awake — no blame.
  const brief = suspensionNote(0, 150_000, { sleptAtMs: 30_000, wokeAtMs: 31_000 }, 150_000);
  assert.ok(brief !== undefined && /slept ≥1s/.test(brief) && !/retry/.test(brief), brief);
  assert.equal(suspensionNote(end + 1, end + 2, INCIDENT, 150_000), undefined);
  assert.equal(suspensionNote(start, end, undefined, 150_000), undefined);
});

function capture(): { usage: UsageLogger; records: UsageLogEntry[] } {
  const records: UsageLogEntry[] = [];
  return {
    records,
    usage: {
      record: (e) => records.push(e),
      begin: () => ({ clear: () => undefined }),
      dispose: () => undefined,
    },
  };
}

async function recordCall(durationMs: number, sleptAtOffset: number): Promise<UsageLogEntry> {
  const clock = manualClock();
  const t0 = clock.now();
  const { usage, records } = capture();
  await withCallTelemetry({
    usage,
    clock,
    tool: 'extract_symbol',
    args: {},
    cwd: '/r',
    lastSuspension: () =>
      Promise.resolve({ sleptAtMs: t0 + sleptAtOffset, wokeAtMs: t0 + durationMs - 1_000 }),
    run: () => {
      clock.advance(durationMs);
      return Promise.resolve({ ok: false, ops: [], response: '', isError: false, value: 0 });
    },
  });
  const r = records[0];
  assert.ok(r !== undefined);
  return r;
}

test('usage record: suspendedMs carries the sleep inside a long call, and only there', async () => {
  const slept = await recordCall(460_000, 10_000);
  assert.equal(slept.durationMs, 460_000);
  assert.equal(slept.suspendedMs, 449_000);
  const short = await recordCall(SUSPENSION_PROBE_MIN_MS - 1, 1_000);
  assert.equal('suspendedMs' in short, false, 'a short call is not probed');
});
