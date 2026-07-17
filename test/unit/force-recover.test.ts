// Deterministic coverage for the wedged-daemon force-kill ladder (t-000051). Oracle: a fake process
// (an `alive` flag the fake `signal` flips) + a manual clock — no real process, no sleep. Covers the
// guard branches (no trustworthy target → no kill) and the SIGTERM→SIGKILL escalation, and proves
// every path is bounded (the clock-drive helper caps how far it advances — an unbounded poll would
// blow the cap, catching a spin).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { forceRecoverDaemon, type ForceRecoverDeps } from '../../src/daemon/force-recover.ts';
import type { PidfileRecord } from '../../src/support/pidfile/write.ts';
import type { SignalOutcome } from '../../src/support/pidfile/liveness.ts';
import type { Clock } from '../../src/common/async/clock.ts';

const SOCK = '/tmp/cm-fr.sock';
const PID = 4242;
const rec = (over: Partial<PidfileRecord> = {}): PidfileRecord => ({
  pid: PID,
  socket: SOCK,
  version: 'test',
  startedAt: 1,
  ...over,
});

function manualClock(): Clock & { advance(ms: number): void } {
  let now = 1_000_000;
  const timers: { at: number; fn: () => void }[] = [];
  return {
    now: () => now,
    schedule(ms, fn) {
      const t = { at: now + ms, fn };
      timers.push(t);
      return () => {
        const i = timers.indexOf(t);
        if (i !== -1) timers.splice(i, 1);
      };
    },
    advance(ms) {
      now += ms;
      for (const t of [...timers].sort((a, b) => a.at - b.at)) {
        if (t.at <= now) {
          const i = timers.indexOf(t);
          if (i !== -1) timers.splice(i, 1);
          t.fn();
        }
      }
    },
  };
}

const flush = (): Promise<void> => new Promise((r) => setImmediate(r));

/** Run a force-recover to completion by advancing the manual clock in bounded steps, flushing
 *  microtasks between. The `cap` is the no-spin backstop: a path that needed more steps than this
 *  would be an unbounded poll — the test would fail rather than hang. */
async function settle<T>(p: Promise<T>, clock: ReturnType<typeof manualClock>): Promise<T> {
  let done = false;
  void p.then(() => (done = true));
  for (let i = 0; i < 400 && !done; i++) {
    await flush();
    clock.advance(25);
  }
  await flush();
  return p;
}

/** A fake process + injected seams. `dieOn` names the signal that actually kills it (undefined = it
 *  survives every signal → the still-alive path). */
function scenario(opts: {
  record?: PidfileRecord | undefined;
  aliveAtStart?: boolean;
  dieOn?: NodeJS.Signals;
  reread?: PidfileRecord | undefined;
}): {
  deps: ForceRecoverDeps;
  clock: ReturnType<typeof manualClock>;
  signals: string[];
  removed: number;
} {
  const clock = manualClock();
  const state = { alive: opts.aliveAtStart ?? true };
  const signals: string[] = [];
  const counters = { removed: 0 };
  let reads = 0;
  const deps: ForceRecoverDeps = {
    socketPath: SOCK,
    pidfilePath: '/tmp/cm-fr.sock.pid',
    clock,
    termGraceMs: 2000,
    killConfirmMs: 2000,
    pollIntervalMs: 25,
    readPidfile: () => {
      // First read = the target; a second read returns `reread` when the test exercises the
      // re-read guard, else the same record.
      const r =
        reads === 0
          ? opts.record
          : opts.reread !== undefined || 'reread' in opts
            ? opts.reread
            : opts.record;
      reads++;
      return r;
    },
    isAlive: () => state.alive,
    signal: (_pid, sig): SignalOutcome => {
      signals.push(sig);
      if (opts.dieOn === sig) state.alive = false;
      return state.alive ? 'sent' : 'noProcess';
    },
    removePidfile: () => {
      counters.removed++;
    },
  };
  return {
    deps,
    clock,
    signals,
    get removed() {
      return counters.removed;
    },
  };
}

test('no pidfile → no-target (caller falls back to the manual kill hint)', async () => {
  const s = scenario({ record: undefined });
  const r = await settle(forceRecoverDaemon(s.deps), s.clock);
  assert.deepEqual(r, { kind: 'no-target', reason: 'no usable pidfile hint' });
  assert.deepEqual(s.signals, [], 'never signals without a target');
});

test('pidfile names a different socket → no-target (never kills an unrelated daemon)', async () => {
  const s = scenario({ record: rec({ socket: '/tmp/other.sock' }) });
  const r = await settle(forceRecoverDaemon(s.deps), s.clock);
  assert.equal(r.kind, 'no-target');
  assert.deepEqual(s.signals, []);
});

test('target pid already gone → already-gone, stale pidfile cleared, no signal', async () => {
  const s = scenario({ record: rec(), aliveAtStart: false });
  const r = await settle(forceRecoverDaemon(s.deps), s.clock);
  assert.deepEqual(r, { kind: 'already-gone', pid: PID });
  assert.deepEqual(s.signals, []);
  assert.equal(s.removed, 1, 'stale pidfile removed');
});

test('re-read shows a different pid → target-changed, aborts the kill (anti-recycle guard)', async () => {
  const s = scenario({ record: rec(), reread: rec({ pid: 9999 }) });
  const r = await settle(forceRecoverDaemon(s.deps), s.clock);
  assert.deepEqual(r, { kind: 'target-changed' });
  assert.deepEqual(s.signals, [], 'a changed target is never signalled');
});

test('honors SIGTERM → killed without escalating to SIGKILL', async () => {
  const s = scenario({ record: rec(), dieOn: 'SIGTERM' });
  const r = await settle(forceRecoverDaemon(s.deps), s.clock);
  assert.deepEqual(r, { kind: 'killed', pid: PID });
  assert.deepEqual(s.signals, ['SIGTERM'], 'no SIGKILL needed');
  assert.equal(s.removed, 1);
});

test('survives SIGTERM, dies on SIGKILL → killed after escalation', async () => {
  const s = scenario({ record: rec(), dieOn: 'SIGKILL' });
  const r = await settle(forceRecoverDaemon(s.deps), s.clock);
  assert.deepEqual(r, { kind: 'killed', pid: PID });
  assert.deepEqual(s.signals, ['SIGTERM', 'SIGKILL'], 'escalated after the grace elapsed');
});

test('survives even SIGKILL within budget → still-alive (honest, bounded, no spin)', async () => {
  const s = scenario({ record: rec() }); // dieOn omitted → survives every signal
  const r = await settle(forceRecoverDaemon(s.deps), s.clock);
  assert.deepEqual(r, { kind: 'still-alive', pid: PID });
  assert.deepEqual(s.signals, ['SIGTERM', 'SIGKILL']);
  assert.equal(s.removed, 0, 'no stale-pidfile removal while the process is still alive');
});
