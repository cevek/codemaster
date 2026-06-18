// The unix-socket `Transport` impl (spec-daemon-singleton §4/§19). Wraps `node:net` behind the
// `Transport` seam: NDJSON framing per connection, user-only (0600) socket perms, length-asserted
// bind, and socket-file unlink on `close()` so a racing `connect()` gets ECONNREFUSED → the
// convergence recovery path. A Windows named-pipe impl drops in behind the same seam later.

import * as net from 'node:net';
import * as fs from 'node:fs';
import type { JsonValue } from '../../core/json.ts';
import type { Transport, TransportConnection, TransportServer } from './seam.ts';
import { createLineDecoder, encodeLine } from './ndjson.ts';
import { assertSocketPathLength } from './socket-path.ts';

/** Build a unix-socket transport bound to (or connecting to) `socket`. */
export function createUnixSocketTransport(socket: string): Transport {
  return {
    listen: () => listen(socket),
    connect: () => connect(socket),
  };
}

function wrapSocket(raw: net.Socket): TransportConnection {
  const decoder = createLineDecoder();
  let onMessage: (m: JsonValue) => void = () => undefined;
  let onClose: () => void = () => undefined;
  let onError: (e: Error) => void = () => undefined;
  let closed = false;

  raw.setEncoding('utf8');
  raw.on('data', (chunk: string) => {
    let messages: JsonValue[];
    try {
      messages = decoder.push(chunk);
    } catch (thrown) {
      // A malformed line is a non-fatal protocol error — report it, keep the link (§3.6: never
      // crash the peer). The protocol layer's zod guard rejects structurally-wrong-but-valid JSON.
      onError(thrown instanceof Error ? thrown : new Error(String(thrown)));
      return;
    }
    for (const message of messages) onMessage(message);
  });
  raw.on('error', (err) => onError(err)); // a 'close' event always follows
  raw.on('close', () => {
    if (closed) return;
    closed = true;
    onClose();
  });

  return {
    send(message) {
      if (!closed) raw.write(encodeLine(message));
    },
    onMessage: (handler) => void (onMessage = handler),
    onClose: (handler) => void (onClose = handler),
    onError: (handler) => void (onError = handler),
    close() {
      if (closed) return Promise.resolve();
      closed = true;
      return new Promise<void>((resolve) => raw.end(() => resolve()));
    },
  };
}

function listen(socketPath: string): Promise<TransportServer> {
  return new Promise<TransportServer>((resolve, reject) => {
    try {
      assertSocketPathLength(socketPath); // §19 — honest throw, never a cryptic bind failure
    } catch (thrown) {
      reject(thrown instanceof Error ? thrown : new Error(String(thrown)));
      return;
    }

    let onConnection: ((c: TransportConnection) => void) | undefined;
    const pending: TransportConnection[] = []; // connections accepted before the handler registers
    const live = new Set<net.Socket>(); // tracked so close() never hangs on open links

    const server = net.createServer((raw) => {
      live.add(raw);
      raw.on('close', () => live.delete(raw));
      const connection = wrapSocket(raw);
      if (onConnection !== undefined) onConnection(connection);
      else pending.push(connection);
    });

    server.once('error', reject); // EADDRINUSE etc. during bind → reject with `.code` preserved
    server.listen(socketPath, () => {
      server.removeListener('error', reject);
      // User-only perms: a local socket must not accept ops from another local user (§9 local-only).
      try {
        fs.chmodSync(socketPath, 0o600);
      } catch {
        // best-effort hardening; a failure here is not worth refusing to serve
      }
      resolve({
        address: socketPath,
        onConnection(handler) {
          onConnection = handler;
          while (pending.length > 0) {
            const connection = pending.shift();
            if (connection !== undefined) handler(connection);
          }
        },
        close() {
          return new Promise<void>((done) => {
            // Destroy live links first — `net.Server.close` otherwise waits for every open
            // connection to end on its own, which would hang shutdown (§1 never-hang).
            for (const raw of live) raw.destroy();
            live.clear();
            server.close(() => {
              // Unlink so a racing connect gets ECONNREFUSED/ENOENT → recovery (§2c).
              try {
                fs.unlinkSync(socketPath);
              } catch {
                // already gone — fine
              }
              done();
            });
          });
        },
      });
    });
  });
}

function connect(socketPath: string): Promise<TransportConnection> {
  return new Promise<TransportConnection>((resolve, reject) => {
    const raw = net.connect(socketPath);
    raw.once('error', reject); // ENOENT (no socket file) / ECONNREFUSED (stale) → branch in §2c
    raw.once('connect', () => {
      raw.removeListener('error', reject);
      resolve(wrapSocket(raw));
    });
  });
}
