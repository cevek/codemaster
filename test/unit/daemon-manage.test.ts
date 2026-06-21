// Deterministic oracles for the daemon management verbs (spec-daemon-cli). Fake in-memory transports
// + a manual clock — no real socket, no sleep. These cover the paths the healthy real-socket smoke
// (daemon-cli-smoke.test.ts) CANNOT reach: the NO-HANG honest-failure paths (a daemon that accepts
// but never replies / never closes → bounded → honest "unresponsive" / "kill the pid", never a
// spin), the legacy-daemon error-reply mapping (an old daemon that rejects the new kinds), and
// restart's refusal to start while a wedged daemon still holds the socket. Plus the protocol zod
// round-trip for the new envelopes.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runDaemonCommand, type DaemonManageDeps } from '../../src/daemon/manage.ts';
import { parseWireRequest, parseWireReply } from '../../src/daemon/protocol.ts';
import type { Clock } from '../../src/common/async/clock.ts';
import type { JsonValue } from '../../src/core/json.ts';
import type { Transport, TransportConnection } from '../../src/support/transport/seam.ts';

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

interface Envelope {
  id: number;
  kind: string;
}

/** A programmable connection: `onSend` decides how to react to each outbound envelope (deliver a
 *  reply, close the link, or ignore it — a wedged daemon). */
function fakeConnection(
  onSend: (env: Envelope, deliver: (reply: JsonValue) => void, close: () => void) => void,
): TransportConnection {
  let onMsg: (m: JsonValue) => void = () => undefined;
  let onCloseCb: () => void = () => undefined;
  return {
    send(envelope) {
      onSend(
        envelope as unknown as Envelope,
        (reply) => queueMicrotask(() => onMsg(reply)),
        () => queueMicrotask(() => onCloseCb()),
      );
    },
    onMessage: (h) => void (onMsg = h),
    onClose: (h) => void (onCloseCb = h),
    onError: () => undefined,
    close: () => Promise.resolve(),
  };
}

/** A transport that yields `conn` on connect, or rejects ENOENT when `conn` is undefined (no daemon). */
function transportFor(conn: TransportConnection | undefined): Transport {
  return {
    listen: () => Promise.reject(new Error('listen unused in manage tests')),
    connect: () =>
      conn === undefined
        ? Promise.reject(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }))
        : Promise.resolve(conn),
  };
}

function deps(over: Partial<DaemonManageDeps>): DaemonManageDeps {
  return {
    transport: transportFor(undefined),
    socketPath: '/tmp/cm-test.sock',
    clock: manualClock(),
    spawnDaemon: () => undefined,
    replyDeadlineMs: 1000,
    stopTimeoutMs: 2000,
    ...over,
  };
}

const infoReply = (id: number, info: Record<string, unknown>, sourceStale = false): JsonValue =>
  ({ id, kind: 'daemon-info', sourceStale, info }) as unknown as JsonValue;
const errReply = (id: number, message: string): JsonValue =>
  ({ id, kind: 'error', message }) as unknown as JsonValue;
const INFO = { pid: 42, uptimeMs: 65_000, engines: 2, engineRoots: ['/a', '/b'] };

test('status: no daemon → honest "no daemon running" (code 0)', async () => {
  const r = await runDaemonCommand('status', deps({}));
  assert.equal(r.code, 0);
  assert.match(r.lines.join('\n'), /no daemon running/);
});

test('status: healthy daemon → pid/uptime/engines + warm roots + stale remedy', async () => {
  const conn = fakeConnection((env, deliver) => {
    if (env.kind === 'daemon-info') deliver(infoReply(env.id, INFO, true));
  });
  const r = await runDaemonCommand('status', deps({ transport: transportFor(conn) }));
  assert.equal(r.code, 0);
  const out = r.lines.join('\n');
  assert.match(out, /daemon running pid=42 uptime=1m05s engines=2/);
  assert.match(out, /warm roots: \/a · \/b/);
  assert.match(out, /daemon restart/, 'a stale daemon surfaces the restart remedy');
});

test('status: NO-HANG — a daemon that never replies → honest "UNRESPONSIVE" after the deadline', async () => {
  const clock = manualClock();
  const wedged = fakeConnection(() => undefined); // accepts, never replies, never closes
  const p = runDaemonCommand('status', deps({ transport: transportFor(wedged), clock }));
  await flush();
  clock.advance(1000); // past replyDeadlineMs — the only thing that resolves it (no spin)
  const r = await p;
  assert.equal(r.code, 1);
  assert.match(r.lines.join('\n'), /UNRESPONSIVE/);
});

test('status: a legacy daemon that rejects daemon-info (error reply) → "older protocol" remedy', async () => {
  const old = fakeConnection((env, deliver) => deliver(errReply(env.id, 'bad request envelope')));
  const r = await runDaemonCommand('status', deps({ transport: transportFor(old) }));
  assert.equal(r.code, 1);
  assert.match(r.lines.join('\n'), /does not speak daemon-info.*daemon restart/s);
});

test('start: already running → reports the pid, never spawns', async () => {
  let spawned = false;
  const conn = fakeConnection((env, deliver) => {
    if (env.kind === 'daemon-info') deliver(infoReply(env.id, INFO));
  });
  const r = await runDaemonCommand(
    'start',
    deps({ transport: transportFor(conn), spawnDaemon: () => (spawned = true) }),
  );
  assert.equal(r.code, 0);
  assert.match(r.lines.join('\n'), /already running \(pid=42/);
  assert.equal(spawned, false, 'an already-up daemon is not re-spawned');
});

test('stop: none running → honest "no daemon running"', async () => {
  const r = await runDaemonCommand('stop', deps({}));
  assert.equal(r.code, 0);
  assert.match(r.lines.join('\n'), /no daemon running/);
});

test('stop: healthy → shutdown then connection close = confirmation (socket released, pid)', async () => {
  const conn = fakeConnection((env, deliver, close) => {
    if (env.kind === 'daemon-info') deliver(infoReply(env.id, INFO));
    if (env.kind === 'shutdown') close(); // the daemon closes the listener → our link closes
  });
  const r = await runDaemonCommand('stop', deps({ transport: transportFor(conn) }));
  assert.equal(r.code, 0);
  const out = r.lines.join('\n');
  assert.match(out, /daemon stopped \(socket released, pid 42\)/);
  assert.match(out, /must reconnect/);
});

test('stop: NO-HANG — a wedged daemon never closes → honest "kill the pid" after the deadline', async () => {
  const clock = manualClock();
  // Replies to daemon-info (so we get the pid) but ignores shutdown (never closes).
  const wedged = fakeConnection((env, deliver) => {
    if (env.kind === 'daemon-info') deliver(infoReply(env.id, INFO));
  });
  const p = runDaemonCommand('stop', deps({ transport: transportFor(wedged), clock }));
  await flush(); // daemon-info reply lands (microtask), then awaitClose schedules
  clock.advance(2000); // past stopTimeoutMs
  const r = await p;
  assert.equal(r.code, 1);
  assert.match(r.lines.join('\n'), /couldn't stop daemon gracefully.*kill 42/s);
});

test('restart: a wedged daemon that cannot be stopped is NOT restarted (would EADDRINUSE)', async () => {
  const clock = manualClock();
  let spawned = false;
  const wedged = fakeConnection(() => undefined); // never replies, never closes
  const p = runDaemonCommand(
    'restart',
    deps({ transport: transportFor(wedged), clock, spawnDaemon: () => (spawned = true) }),
  );
  await flush();
  clock.advance(1000); // daemon-info deadline (no pid)
  await flush();
  clock.advance(2000); // stop await-close deadline
  const r = await p;
  assert.equal(r.code, 1);
  assert.match(r.lines.join('\n'), /not starting a new daemon/);
  assert.equal(spawned, false, 'restart must not spawn while the old daemon holds the socket');
});

test('restart: healthy daemon → "daemon stopped (pid)" then "daemon started (fresh pid)" + reconnect (code 0)', async () => {
  // The deterministic home for the successful restart-while-live WORDING. The real-socket smoke
  // (daemon-cli-smoke.test.ts) no longer pins this — a restart verb's own stdout flush races under
  // CI load (a code-0 reply can land with truncated stdout), so the smoke proves the load-independent
  // lifecycle pid-change instead. Here, no socket and no flush: the old daemon replies to daemon-info
  // (pid 42) and closes on shutdown; the freshly spawned daemon answers daemon-info with pid 99.
  const old = fakeConnection((env, deliver, close) => {
    if (env.kind === 'daemon-info') deliver(infoReply(env.id, INFO)); // pid 42
    if (env.kind === 'shutdown') close();
  });
  const fresh = fakeConnection((env, deliver) => {
    if (env.kind === 'daemon-info') deliver(infoReply(env.id, { ...INFO, pid: 99 }));
  });
  // The connect() sequence across one restart: stop's tryConnect lands on `old`; after stop closes
  // it, daemonStart's tryConnect + connectOrSpawn's probe/reprobe see no daemon (ENOENT), then the
  // spawned one answers — so [old, ✗, ✗, ✗, fresh], the rest being the post-spawn `fresh`.
  const conns: (TransportConnection | undefined)[] = [old, undefined, undefined, undefined, fresh];
  let i = 0;
  const transport: Transport = {
    listen: () => Promise.reject(new Error('listen unused in manage tests')),
    connect: () => {
      const c = i < conns.length ? conns[i++] : fresh;
      return c === undefined
        ? Promise.reject(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }))
        : Promise.resolve(c);
    },
  };
  let spawned = false;
  const r = await runDaemonCommand(
    'restart',
    deps({ transport, spawnDaemon: () => (spawned = true) }),
  );
  assert.equal(r.code, 0);
  assert.equal(spawned, true, 'restart spawned a fresh daemon after stopping the old one');
  const out = r.lines.join('\n');
  assert.match(out, /daemon stopped \(socket released, pid 42\)/, 'stops the live daemon by pid');
  assert.match(out, /daemon started \(pid=99\)/, 'then starts a fresh one');
  assert.match(out, /daemon stopped[\s\S]*daemon started/, 'stop precedes start in the output');
  assert.match(out, /must reconnect/, 'warns connected clients to reconnect');
});

test('unknown verb → honest usage line (code 2)', async () => {
  const r = await runDaemonCommand('frobnicate', deps({}));
  assert.equal(r.code, 2);
  assert.match(r.lines.join('\n'), /unknown daemon verb/);
});

test('protocol: the new daemon-info / shutdown request envelopes validate; the reply round-trips', () => {
  assert.ok(parseWireRequest({ id: 1, kind: 'daemon-info' } as unknown as JsonValue).ok);
  assert.ok(parseWireRequest({ id: 2, kind: 'shutdown' } as unknown as JsonValue).ok);
  // A daemon-info reply with a well-formed info payload parses; a malformed info is rejected honestly.
  assert.ok(parseWireReply(infoReply(1, INFO)).ok);
  const bad = parseWireReply({
    id: 1,
    kind: 'daemon-info',
    sourceStale: false,
    info: { pid: 'x' },
  } as unknown as JsonValue);
  assert.equal(bad.ok, false, 'a non-numeric pid in the info payload fails the zod guard');
  // An unknown request kind is still rejected (the discriminated union is closed).
  assert.equal(parseWireRequest({ id: 3, kind: 'nope' } as unknown as JsonValue).ok, false);
});
