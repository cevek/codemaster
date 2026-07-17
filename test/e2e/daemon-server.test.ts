// The daemon front door (spec-daemon-singleton §2/§3/§7). Drives `serveDaemon` over a REAL unix
// socket with a stub orchestrator (the heavy LS isn't the daemon-layer's concern — protocol +
// routing + idle-exit are) and an injected clock for the deterministic idle-exit (no sleep, §7).
// Oracles: replies match requests by id, a slow op never head-of-line-blocks another connection,
// the daemon idle-exits + unlinks only at zero connections, and a thrown op fails honestly.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { serveDaemon, type DaemonHandle } from '../../src/daemon/daemon-server.ts';
import type { ServingOrchestrator } from '../../src/daemon/orchestrator-api.ts';
import { createUnixSocketTransport } from '../../src/support/transport/unix-socket.ts';
import { socketPath } from '../../src/support/transport/socket-path.ts';
import { pidfilePathFor } from '../../src/support/pidfile/write.ts';
import { readPidfile } from '../../src/support/pidfile/read.ts';
import type { Transport, TransportConnection } from '../../src/support/transport/seam.ts';
import type { Clock } from '../../src/common/async/clock.ts';
import type { JsonValue } from '../../src/core/json.ts';
import type { StatusView } from '../../src/format/render/render-status.ts';

process.setMaxListeners(50); // serveDaemon adds SIGTERM/SIGINT listeners per instance

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

const STATUS_VIEW: StatusView = {
  daemonVersion: 'test',
  pid: 1,
  isolation: 'in-process',
  engines: 0,
  engineRoots: [],
  workspace: undefined,
  workspaceError: undefined,
  debugTopics: [],
  sourceStale: false,
};

function stubOrch(over: Partial<ServingOrchestrator> = {}): ServingOrchestrator {
  return {
    request: async () => ({
      ok: true,
      results: [{ name: 'find_definition', error: { kind: 'op_threw', message: 'stub' } }],
    }),
    status: async () => STATUS_VIEW,
    sourceStale: () => false,
    daemonInfo: () => ({ pid: 1, uptimeMs: 0, engines: 0, engineRoots: [] }),
    dispose: async () => undefined,
    ...over,
  };
}

interface Harness {
  daemon: DaemonHandle;
  transport: Transport;
  clock: Clock & { advance(ms: number): void };
  exits: number[];
  dir: string;
  cleanup(): Promise<void>;
}

async function harness(orch: ServingOrchestrator, idleMs = 1000): Promise<Harness> {
  const dir = mkdtempSync(path.join(tmpdir(), 'cm-dmn-'));
  const transport = createUnixSocketTransport(socketPath('test', dir));
  const clock = manualClock();
  const exits: number[] = [];
  const daemon = await serveDaemon({
    orchestrator: orch,
    transport,
    clock,
    idleMs,
    exit: (code) => exits.push(code),
  });
  return {
    daemon,
    transport,
    clock,
    exits,
    dir,
    async cleanup() {
      await daemon.shutdown();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** A raw test client: connect, send envelopes, resolve replies by id. */
async function client(transport: Transport): Promise<{
  call(env: JsonValue, id: number): Promise<unknown>;
  conn: TransportConnection;
}> {
  const conn = await transport.connect();
  const waiters = new Map<number, (m: unknown) => void>();
  conn.onMessage((msg) => {
    const id = (msg as { id?: number }).id;
    if (typeof id === 'number') waiters.get(id)?.(msg);
  });
  return {
    conn,
    call(env, id) {
      return new Promise<unknown>((resolve) => {
        waiters.set(id, resolve);
        conn.send(env);
      });
    },
  };
}

test('daemon: request round-trip — reply matches by id, carries sourceStale', async () => {
  const h = await harness(stubOrch({ sourceStale: () => true }));
  try {
    const c = await client(h.transport);
    const reply = (await c.call(
      { id: 7, kind: 'request', cwd: '/x', reqs: [{ name: 'find_definition', args: {} }] },
      7,
    )) as { id: number; kind: string; sourceStale: boolean; outcome: { ok: boolean } };
    assert.equal(reply.id, 7);
    assert.equal(reply.kind, 'request');
    assert.equal(reply.sourceStale, true, 'daemon stamps sourceStale on the reply');
    assert.equal(reply.outcome.ok, true);
    await c.conn.close();
  } finally {
    await h.cleanup();
  }
});

test('daemon: status round-trip returns the view', async () => {
  const h = await harness(stubOrch());
  try {
    const c = await client(h.transport);
    const reply = (await c.call({ id: 1, kind: 'status', cwd: '/x' }, 1)) as {
      kind: string;
      view: StatusView;
    };
    assert.equal(reply.kind, 'status');
    assert.equal(reply.view.daemonVersion, 'test');
    await c.conn.close();
  } finally {
    await h.cleanup();
  }
});

test('daemon: a malformed envelope gets an honest error reply (daemon survives)', async () => {
  const h = await harness(stubOrch());
  try {
    const c = await client(h.transport);
    const reply = (await c.call({ id: 9, kind: 'nonsense' }, 9)) as {
      kind: string;
      message: string;
    };
    assert.equal(reply.kind, 'error');
    assert.match(reply.message, /bad request envelope/);
    // daemon still answers a good request afterward
    const ok = (await c.call({ id: 10, kind: 'status', cwd: '/x' }, 10)) as { kind: string };
    assert.equal(ok.kind, 'status');
    await c.conn.close();
  } finally {
    await h.cleanup();
  }
});

test('daemon: an orchestrator throw becomes an error reply, not a crash', async () => {
  const h = await harness(
    stubOrch({
      request: async () => {
        throw new Error('engine boom');
      },
    }),
  );
  try {
    const c = await client(h.transport);
    const reply = (await c.call(
      { id: 3, kind: 'request', cwd: '/x', reqs: [{ name: 'find_definition', args: {} }] },
      3,
    )) as { kind: string; message: string };
    assert.equal(reply.kind, 'error');
    assert.match(reply.message, /engine boom/);
    await c.conn.close();
  } finally {
    await h.cleanup();
  }
});

test('daemon: a slow op on one connection does not block another (accept/route never blocks)', async () => {
  let release: () => void = () => undefined;
  const gate = new Promise<void>((r) => (release = r));
  let n = 0;
  const h = await harness(
    stubOrch({
      request: async () => {
        n += 1;
        if (n === 1) await gate; // first request hangs
        return { ok: true, results: [] };
      },
    }),
  );
  try {
    const a = await client(h.transport);
    const b = await client(h.transport);
    const slow = a.call({ id: 1, kind: 'request', cwd: '/x', reqs: [{ name: 'x', args: {} }] }, 1);
    const fast = b.call({ id: 2, kind: 'request', cwd: '/x', reqs: [{ name: 'x', args: {} }] }, 2);
    // B's reply arrives while A is still gated.
    const fastReply = (await fast) as { id: number; outcome: { ok: boolean } };
    assert.equal(fastReply.id, 2);
    assert.equal(fastReply.outcome.ok, true);
    release();
    await slow;
    await a.conn.close();
    await b.conn.close();
  } finally {
    await h.cleanup();
  }
});

test('daemon: idle self-exits + unlinks socket only at zero connections after the TTL', async () => {
  const h = await harness(stubOrch(), 1000);
  const sock = h.daemon.address;
  try {
    assert.ok(existsSync(sock), 'socket bound');
    // A connection holds the daemon: advancing past the TTL must NOT exit.
    const c = await client(h.transport);
    h.clock.advance(5000);
    await flush();
    assert.deepEqual(h.exits, [], 'open connection prevents idle-exit');

    await c.conn.close();
    // The daemon observes the socket close asynchronously (a real FIN round-trip), which fires
    // onClose → idle.leave() → re-arm. Yield bounded REAL ticks for that teardown (NOT the TTL —
    // the TTL stays the injected clock, advanced each turn so the re-armed deadline fires once
    // leave() has run). Bounded → never hangs.
    for (let i = 0; i < 100 && h.exits.length === 0; i += 1) {
      h.clock.advance(2000);
      await flush();
      if (h.exits.length === 0) await new Promise((r) => setTimeout(r, 5));
    }
    assert.deepEqual(h.exits, [0], 'idle-exit fires after last disconnect + TTL');
    assert.equal(existsSync(sock), false, 'socket unlinked on idle-exit');
  } finally {
    rmSync(h.dir, { recursive: true, force: true });
  }
});

test('daemon: writes a kill-target-hint pidfile at bind and removes it on graceful shutdown (t-000051)', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'cm-dmn-pid-'));
  const sock = socketPath('test', dir);
  const pidfilePath = pidfilePathFor(sock);
  const transport = createUnixSocketTransport(sock);
  const clock = manualClock();
  const exits: number[] = [];
  const daemon = await serveDaemon({
    orchestrator: stubOrch(),
    transport,
    clock,
    idleMs: 600_000, // not under test — we drive shutdown explicitly
    exit: (c) => exits.push(c),
    pidfile: { path: pidfilePath, socket: sock, version: 'test' },
  });
  try {
    const rec = readPidfile(pidfilePath);
    assert.ok(rec !== undefined, 'pidfile written after a successful bind');
    assert.equal(rec?.pid, process.pid, 'names this process');
    assert.equal(rec?.socket, sock, 'carries the socket for the identity guard');
    assert.equal(rec?.version, 'test');
    await daemon.shutdown();
    assert.deepEqual(exits, [0]);
    assert.equal(readPidfile(pidfilePath), undefined, 'pidfile removed on graceful shutdown');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('daemon: a daemon nobody ever connects to idle-exits + unlinks (fully deterministic)', async () => {
  const h = await harness(stubOrch(), 1000);
  const sock = h.daemon.address;
  try {
    assert.ok(existsSync(sock));
    h.clock.advance(999);
    await flush();
    assert.deepEqual(h.exits, [], 'not yet — under TTL');
    h.clock.advance(1);
    await flush();
    await flush();
    assert.deepEqual(h.exits, [0], 'idle-exit after TTL with zero connections');
    assert.equal(existsSync(sock), false, 'socket unlinked');
  } finally {
    rmSync(h.dir, { recursive: true, force: true });
  }
});
