// The one REAL-socket smoke for the Transport seam (spec-daemon-singleton §7). Drives an actual
// `node:net` unix socket: bidirectional NDJSON round-trip, user-only perms, concurrent connections
// (the accept loop serves more than one, and a slow peer doesn't block another), and unlink-on-close
// → a later connect honestly refuses. No injected clock needed — this is the live-IO oracle.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as net from 'node:net';
import { mkdtempSync, rmSync, statSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { createUnixSocketTransport } from '../../src/support/transport/unix-socket.ts';
import { socketPath } from '../../src/support/transport/socket-path.ts';
import type { TransportConnection, TransportServer } from '../../src/support/transport/seam.ts';
import type { JsonValue } from '../../src/core/json.ts';

function nextMessage(conn: TransportConnection): Promise<JsonValue> {
  return new Promise((resolve) => conn.onMessage(resolve));
}

async function withServer(
  run: (
    server: TransportServer,
    sockPath: string,
    connect: () => Promise<TransportConnection>,
  ) => Promise<void>,
): Promise<void> {
  const dir = mkdtempSync(path.join(tmpdir(), 'cm-sock-'));
  const sockPath = socketPath('test', dir);
  const transport = createUnixSocketTransport(sockPath);
  const server = await transport.listen();
  try {
    await run(server, sockPath, () => transport.connect());
  } finally {
    await server.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

test('transport: bidirectional NDJSON round-trip over a real socket', async () => {
  await withServer(async (server, _p, connect) => {
    const accepted = new Promise<TransportConnection>((resolve) => server.onConnection(resolve));
    const client = await connect();
    const serverConn = await accepted;

    client.send({ from: 'client', n: 1 });
    assert.deepEqual(await nextMessage(serverConn), { from: 'client', n: 1 });

    serverConn.send({ from: 'server', ok: true });
    assert.deepEqual(await nextMessage(client), { from: 'server', ok: true });
  });
});

test('transport: socket file is user-only (0600)', async () => {
  await withServer(async (_server, sockPath) => {
    const mode = statSync(sockPath).mode & 0o777;
    assert.equal(mode, 0o600, `expected 0600, got ${mode.toString(8)}`);
  });
});

test('transport: serves concurrent connections; a slow peer does not block another', async () => {
  await withServer(async (server, _p, connect) => {
    // Server echoes — but connection A's echo is withheld behind a gate, so if the accept/serve
    // loop were blocked on A, B would never get its reply.
    let releaseA: () => void = () => undefined;
    const gateA = new Promise<void>((r) => (releaseA = r));
    let seen = 0;
    server.onConnection((conn) => {
      const mine = (seen += 1);
      conn.onMessage((msg) => {
        if (mine === 1) void gateA.then(() => conn.send(msg));
        else conn.send(msg); // B replies immediately
      });
    });

    const a = await connect();
    const b = await connect();
    a.send({ who: 'a' });
    b.send({ who: 'b' });

    // B's reply must arrive while A is still gated — proves no head-of-line block.
    assert.deepEqual(await nextMessage(b), { who: 'b' });
    releaseA();
    assert.deepEqual(await nextMessage(a), { who: 'a' });
  });
});

test('transport: a corrupt (undecodable) line closes the link honestly (no crash, bounded)', async () => {
  await withServer(async (server, sockPath) => {
    const closed = new Promise<void>((resolve) =>
      server.onConnection((conn) => conn.onClose(resolve)),
    );
    // Bypass the typed `send` to put raw non-JSON bytes on the wire — the decode failure must close
    // the link (same path an over-cap unterminated blob takes), never crash the daemon.
    const raw = net.connect(sockPath);
    await new Promise<void>((resolve) => raw.once('connect', () => resolve()));
    raw.write('{this is not json}\n');
    await closed; // resolves → the server closed the link honestly
    raw.destroy();
  });
});

// A close is a FACT about the link, not an event you had to be subscribed for. The oracle is the
// real socket: the peer really is gone (the server destroyed it and we awaited that), so a handler
// registered afterwards must still learn it. Missing it makes every await-close on that link run to
// its full deadline and then report a timeout — "unresponsive" asserted about a provably dead
// daemon (§1/§3.6). The management verbs read exactly this ordering when they probe a daemon that
// is on its way out.
test('transport: a close handler registered AFTER the close still fires (never a missed close)', async () => {
  await withServer(async (server, _sockPath, connect) => {
    const accepted = new Promise<TransportConnection>((resolve) => server.onConnection(resolve));
    const client = await connect();
    const serverSide = await accepted;
    // Prove the client link is already down before anyone subscribes: await the close on a
    // DIFFERENT (early) registration, then register a second handler on the same connection.
    const firstSaw = new Promise<void>((resolve) => client.onClose(resolve));
    await serverSide.close();
    await firstSaw;

    const late = await new Promise<'fired' | 'missed'>((resolve) => {
      const timer = setTimeout(() => resolve('missed'), 1000);
      client.onClose(() => {
        clearTimeout(timer);
        resolve('fired');
      });
    });
    assert.equal(late, 'fired', 'a late-registered close handler is told the link is already gone');
  });
});

test('transport: close() unlinks the socket; a later connect refuses (recovery path)', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'cm-sock-'));
  const sockPath = socketPath('test', dir);
  const transport = createUnixSocketTransport(sockPath);
  const server = await transport.listen();
  assert.ok(existsSync(sockPath), 'socket file exists while bound');
  await server.close();
  assert.equal(existsSync(sockPath), false, 'socket file unlinked on close');

  await assert.rejects(
    () => transport.connect(),
    (err: NodeJS.ErrnoException) => err.code === 'ENOENT' || err.code === 'ECONNREFUSED',
    'connect to a gone daemon rejects with ENOENT/ECONNREFUSED (no hang)',
  );
  rmSync(dir, { recursive: true, force: true });
});
