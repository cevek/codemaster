// t-000051: the wedged-daemon force-recover MAPPING in the management verbs (pidfile set → escalate
// past the manual hint). Deterministic: an injected `forceRecover` drives each ForceRecoverResult
// kind so the verb's code/lines mapping is pinned without a real process; the SIGTERM→SIGKILL ladder
// itself is covered by force-recover.test.ts, and the real end-to-end by the SIGSTOP smoke.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runDaemonCommand } from '../../src/daemon/manage.ts';
import type { Transport, TransportConnection } from '../../src/support/transport/seam.ts';
import {
  INFO,
  deps,
  fakeConnection,
  flush,
  infoReply,
  manualClock,
  transportFor,
} from '../helpers/daemon-manage-fakes.ts';

/** Drive a wedged `stop`/`restart` to the force-recover branch: the daemon replies to daemon-info
 *  (so we hold the pid) but ignores shutdown (never closes) → awaitClose deadline → force-recover. */
function wedgedConn(): TransportConnection {
  return fakeConnection((env, deliver) => {
    if (env.kind === 'daemon-info') deliver(infoReply(env.id, INFO));
  });
}

test('stop: wedged + pidfile → force-kill confirmed (killed) → code 0, socket released', async () => {
  const clock = manualClock();
  const p = runDaemonCommand(
    'stop',
    deps({
      transport: transportFor(wedgedConn()),
      clock,
      pidfilePath: '/tmp/cm.sock.pid',
      forceRecover: () => Promise.resolve({ kind: 'killed', pid: 42 }),
    }),
  );
  await flush();
  clock.advance(2000); // past stopTimeoutMs → escalate to force-recover
  const r = await p;
  assert.equal(r.code, 0);
  assert.match(r.lines.join('\n'), /force-killed pid 42/);
});

test('stop: wedged + pidfile but SIGKILL never confirmed (still-alive) → code 1, kill -9 hint', async () => {
  const clock = manualClock();
  const p = runDaemonCommand(
    'stop',
    deps({
      transport: transportFor(wedgedConn()),
      clock,
      pidfilePath: '/tmp/cm.sock.pid',
      forceRecover: () => Promise.resolve({ kind: 'still-alive', pid: 42 }),
    }),
  );
  await flush();
  clock.advance(2000);
  const r = await p;
  assert.equal(r.code, 1);
  assert.match(r.lines.join('\n'), /force-kill did not confirm.*kill -9 42/s);
});

test('stop: wedged, pidfile has no trustworthy target (no-target) → degrades to the manual kill hint', async () => {
  const clock = manualClock();
  const p = runDaemonCommand(
    'stop',
    deps({
      transport: transportFor(wedgedConn()),
      clock,
      pidfilePath: '/tmp/cm.sock.pid',
      forceRecover: () => Promise.resolve({ kind: 'no-target', reason: 'no usable pidfile hint' }),
    }),
  );
  await flush();
  clock.advance(2000);
  const r = await p;
  assert.equal(r.code, 1);
  assert.match(r.lines.join('\n'), /couldn't stop daemon gracefully.*kill 42/s);
});

test('restart: wedged daemon force-killed → then a fresh daemon is spawned (code 0)', async () => {
  // stop force-kills the wedged daemon (fake killed) → code 0 → restart proceeds to start, which
  // spawns and converges on the fresh daemon. connect() sequence: stop's daemon-info lands on
  // `wedged`; start's tryConnect + connectOrSpawn probes see no daemon; the spawned one answers.
  const fresh = fakeConnection((env, deliver) => {
    if (env.kind === 'daemon-info') deliver(infoReply(env.id, { ...INFO, pid: 99 }));
  });
  const conns: (TransportConnection | undefined)[] = [
    wedgedConn(),
    undefined,
    undefined,
    undefined,
    fresh,
  ];
  let i = 0;
  const transport: Transport = {
    listen: () => Promise.reject(new Error('listen unused')),
    connect: () => {
      const c = i < conns.length ? conns[i++] : fresh;
      return c === undefined
        ? Promise.reject(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }))
        : Promise.resolve(c);
    },
  };
  const clock = manualClock();
  let spawned = false;
  const p = runDaemonCommand(
    'restart',
    deps({
      transport,
      clock,
      pidfilePath: '/tmp/cm.sock.pid',
      forceRecover: () => Promise.resolve({ kind: 'killed', pid: 42 }),
      spawnDaemon: () => (spawned = true),
    }),
  );
  await flush();
  clock.advance(2000); // stop's await-close deadline → force-kill → proceed to start
  const r = await p;
  assert.equal(r.code, 0);
  assert.equal(spawned, true, 'a fresh daemon is spawned after the wedged one is force-killed');
  const out = r.lines.join('\n');
  assert.match(out, /force-killed pid 42/);
  assert.match(out, /daemon started \(pid=99\)/);
});
