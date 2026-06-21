// The unix-socket `Transport` impl (spec-daemon-singleton §4/§19). Wraps `node:net` behind the
// `Transport` seam: NDJSON framing per connection, user-only (0600) socket perms, length-asserted
// bind, and socket-file unlink on `close()` so a racing `connect()` gets ECONNREFUSED → the
// convergence recovery path. A Windows named-pipe impl drops in behind the same seam later.

import * as net from 'node:net';
import * as fs from 'node:fs';
import * as path from 'node:path';
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
  let closed = false; // send-guard + close() idempotency
  let closeNotified = false; // onClose fires exactly once, whoever closed (local or peer)
  const notifyClose = (): void => {
    if (closeNotified) return;
    closeNotified = true;
    onClose();
  };

  raw.setEncoding('utf8');
  raw.on('data', (chunk: string) => {
    let messages: JsonValue[];
    try {
      messages = decoder.push(chunk);
    } catch (thrown) {
      // A decode failure means the byte stream is corrupt or over-long (framing can't be trusted) —
      // report it and CLOSE the link honestly, never crash the peer (§3.6) and never grow the
      // buffer without bound (§1). A structurally-wrong-but-valid-JSON envelope parses fine here and
      // is caught by the protocol's zod guard instead (an honest error reply, link kept).
      onError(thrown instanceof Error ? thrown : new Error(String(thrown)));
      raw.destroy();
      return;
    }
    for (const message of messages) onMessage(message);
  });
  raw.on('error', (err) => onError(err)); // a 'close' event always follows
  raw.on('close', () => {
    closed = true;
    notifyClose();
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
      // Force a full close (not a half-close `end()`) so `onClose` fires promptly even if the peer
      // doesn't reciprocate — the bridge's in-flight requests must fail at once, never hang (§1).
      return new Promise<void>((resolve) => {
        raw.once('close', () => resolve());
        raw.destroy();
      });
    },
  };
}

function listen(socketPath: string): Promise<TransportServer> {
  return new Promise<TransportServer>((resolve, reject) => {
    try {
      assertSocketPathLength(socketPath); // §19 — honest throw, never a cryptic bind failure
      // The env-independent socket dir (`~/.codemaster/run`, socket-path.ts) may not exist yet on a
      // first daemon spawn — create it (owner-only) before bind. Wrapped so an mkdir failure is an
      // honest reject, never an uncaught crash (§3.6). connect() needs no mkdir: a missing dir →
      // ENOENT → the bridge's spawn path, which lands here.
      fs.mkdirSync(path.dirname(socketPath), { recursive: true, mode: 0o700 });
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

    // Restrict the umask so the socket is CREATED 0600 (no bind→chmod window where another local
    // user could connect); restored on bind success OR error. The daemon does no other file I/O
    // during startup, so the brief process-global umask change is safe. chmod below is belt.
    const prevUmask = process.umask(0o177);
    const onListenError = (err: Error): void => {
      process.umask(prevUmask);
      reject(err); // EADDRINUSE etc. during bind → reject with `.code` preserved
    };
    server.once('error', onListenError);
    server.listen(socketPath, () => {
      process.umask(prevUmask);
      server.removeListener('error', onListenError);
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
