// Deterministic oracles for the one fact `tryConnect` cannot establish: a daemon that ACCEPTS is
// not necessarily a daemon that SERVES (spec-daemon-cli). A daemon committed to exit keeps its
// listener for a beat — the kernel completes a connect into its backlog — and then answers the
// teardown refusal or simply drops the link. Reading either as "already running" makes `start` skip
// the spawn and `restart` report success with nothing running afterwards: the §3.6 lie this file
// pins shut, at the verb level, with no socket and no sleep.
//
// The oracle is each fixture's CONSTRUCTION: the transport declares what occupies the socket at
// each probe, so "a fresh daemon must exist afterwards" is decided by the fixture, never by another
// codemaster answer. The healthy real-socket lifecycle lives in test/e2e/daemon-cli-smoke.test.ts.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runDaemonCommand } from '../../src/daemon/manage.ts';
import { SHUTTING_DOWN_CODE } from '../../src/daemon/protocol.ts';
import {
  INFO,
  closedConnection,
  deps,
  errReply,
  fakeConnection,
  flush,
  infoReply,
  manualClock,
  transportFor,
  transportSequence,
} from '../helpers/daemon-manage-fakes.ts';

/** A daemon mid-teardown: it answers, but only with the refusal that says it is tearing down. */
const draining = () =>
  fakeConnection((env, deliver) =>
    deliver(errReply(env.id, `${SHUTTING_DOWN_CODE}: this daemon is tearing down — reconnect`)),
  );

/** A freshly bound daemon (a pid distinct from the one being replaced). */
const fresh = (pid = 99) =>
  fakeConnection((env, deliver) => {
    if (env.kind === 'daemon-info') deliver(infoReply(env.id, { ...INFO, pid }));
  });

/** Drive a verb whose release-wait polls the clock: let the microtask replies land, then advance
 *  past one poll interval, until the verb settles (bounded — a verb that never settles fails the
 *  test as a hang rather than spinning). No sleep; the manual clock is the only thing that moves. */
async function runWithRelease(
  verb: string,
  over: Parameters<typeof deps>[0],
): Promise<Awaited<ReturnType<typeof runDaemonCommand>>> {
  const clock = manualClock();
  let done = false;
  const p = runDaemonCommand(verb, deps({ clock, releaseTimeoutMs: 300, ...over }));
  void p.then(() => (done = true));
  for (let i = 0; i < 40 && !done; i++) {
    await flush();
    clock.advance(60); // past RELEASE_POLL_MS
  }
  return p;
}

test('start: a daemon that is TEARING DOWN is not "already running" — it waits, then spawns', async () => {
  let spawned = false;
  // Probe 1 catches it draining; by probe 2 the socket is free; then connectOrSpawn's
  // probe/reprobe see nothing and the spawned daemon answers.
  const transport = transportSequence([draining(), undefined, undefined, undefined, fresh()]);
  const r = await runWithRelease('start', { transport, spawnDaemon: () => (spawned = true) });
  assert.equal(spawned, true, 'a draining daemon must not suppress the spawn');
  assert.equal(r.code, 0);
  assert.match(r.lines.join('\n'), /daemon started \(pid=99\)/);
});

test('start: a link that CLOSES without replying is not a live daemon — it spawns (the accept-backlog shape)', async () => {
  let spawned = false;
  const transport = transportSequence([
    closedConnection(),
    undefined,
    undefined,
    undefined,
    fresh(),
  ]);
  const r = await runWithRelease('start', { transport, spawnDaemon: () => (spawned = true) });
  assert.equal(spawned, true, 'a dropped link is a daemon on its way out, not one to defer to');
  assert.equal(r.code, 0);
  assert.match(r.lines.join('\n'), /daemon started \(pid=99\)/);
});

test('start: spawned but nothing confirmed it is SERVING → honest failure, never a claimed start', async () => {
  // Every connect after the spawn lands on a daemon that closes without answering. We connected,
  // so the old code called that "started"; nothing here proves a daemon is serving.
  const transport = transportSequence([undefined, undefined, undefined, closedConnection()]);
  const r = await runWithRelease('start', { transport, spawnDaemon: () => undefined });
  assert.equal(r.code, 1, 'a start is claimed only when a daemon answered as live');
  assert.match(r.lines.join('\n'), /nothing there confirmed it is serving/);
  assert.doesNotMatch(r.lines.join('\n'), /daemon started \(pid/);
});

test('start: a daemon still draining past the wait → honest refusal, never a spawn into a held socket', async () => {
  let spawned = false;
  const transport = transportFor(draining()); // never releases
  const r = await runWithRelease('start', { transport, spawnDaemon: () => (spawned = true) });
  assert.equal(spawned, false, 'a spawn into a held socket loses the bind race and dies silently');
  assert.equal(r.code, 1);
  assert.match(r.lines.join('\n'), /still shutting down/);
});

test('restart: the old daemon still ACCEPTS after stop → a fresh one is still bound (code 0)', async () => {
  // The CI shape end to end: stop's confirmation (the link closing) arrives while the listener is
  // still up, so start's first probe lands back on the daemon being replaced. Restart must not
  // mistake it for a live one and report success with nothing running.
  const old = fakeConnection((env, deliver, close) => {
    if (env.kind === 'daemon-info') deliver(infoReply(env.id, INFO)); // pid 42
    if (env.kind === 'shutdown') close();
  });
  let spawned = false;
  const transport = transportSequence([
    old, // stop
    draining(), // start's first probe — the same daemon, now tearing down
    undefined, // released
    undefined, // connectOrSpawn probe
    undefined, // ... and reprobe
    fresh(), // the spawned daemon
  ]);
  const r = await runWithRelease('restart', { transport, spawnDaemon: () => (spawned = true) });
  assert.equal(spawned, true, 'restart binds a fresh daemon even when the old one still accepts');
  assert.equal(r.code, 0);
  const out = r.lines.join('\n');
  assert.match(out, /daemon stopped \(socket released, pid 42\)/);
  assert.match(out, /daemon started \(pid=99\)/, 'the fresh pid — the "pick up new code" fact');
});

test('stop: a daemon that already dropped the link → honest "already exiting", no force-kill', async () => {
  let forced = false;
  const clock = manualClock();
  const r = await runDaemonCommand(
    'stop',
    deps({
      transport: transportFor(closedConnection()),
      clock,
      pidfilePath: '/tmp/cm-test.pid',
      forceRecover: () => {
        forced = true;
        return Promise.resolve({ kind: 'no-target' as const, reason: 'unused in this test' });
      },
    }),
  );
  assert.equal(r.code, 0);
  assert.match(r.lines.join('\n'), /already exiting/);
  assert.equal(forced, false, 'a dead link is not a wedge — killing on it would target a corpse');
});

test('status: a daemon that drops the link reads as EXITING, never "UNRESPONSIVE"', async () => {
  const r = await runDaemonCommand('status', deps({ transport: transportFor(closedConnection()) }));
  assert.equal(r.code, 0);
  assert.match(r.lines.join('\n'), /exiting/);
  assert.doesNotMatch(r.lines.join('\n'), /UNRESPONSIVE/);
});
