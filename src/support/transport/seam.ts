// The front-door Transport seam (spec-daemon-singleton §4, ARCHITECTURE.md §2/§18). The daemon
// and the bridge both speak `Transport` — never a concrete socket — so a Windows named-pipe impl
// (or any other) drops in later without touching daemon/bridge code, mirroring the `ProjectHost`
// two-impl pattern. The wire is newline-delimited JSON (§18); framing lives in `ndjson.ts`, the
// unix-socket impl in `unix-socket.ts`.
//
// Connection-oriented: a server emits one `TransportConnection` per accepted client; a client
// `connect()` yields one. `send`/`onMessage`/`onClose`/`close` are per-connection. Nothing here
// touches project state — only small protocol envelopes (`daemon/protocol.ts`) cross it.

import type { JsonValue } from '../../core/json.ts';

/** One bidirectional link — a peer's view of a single connection. Both a server-accepted link
 *  and a client `connect()` result are `TransportConnection`. */
export interface TransportConnection {
  /** Enqueue one message as an NDJSON line. Never throws for a transient write — a dead link
   *  surfaces via `onClose`; callers bound their own request/reply by deadline. */
  send(message: JsonValue): void;
  /** Register the per-message handler. A malformed (non-JSON) line is dropped and reported to
   *  `onError` rather than thrown — the link stays honest, never crashes the peer. */
  onMessage(handler: (message: JsonValue) => void): void;
  /** Register a close handler (peer disconnect, socket error, or local `close()`). */
  onClose(handler: () => void): void;
  /** Register a non-fatal error handler (e.g. an undecodable line). */
  onError(handler: (error: Error) => void): void;
  /** Tear down this link. Idempotent. */
  close(): Promise<void>;
}

/** A bound server. Emits a `TransportConnection` per inbound client until `close()`. */
export interface TransportServer {
  /** The bound endpoint (the socket path for the unix impl) — for diagnostics/tests. */
  readonly address: string;
  /** Register the accept handler. Heavy work on a connection must not block this loop
   *  (ARCHITECTURE.md §8) — the daemon hands each connection to async routing. */
  onConnection(handler: (connection: TransportConnection) => void): void;
  /** Stop accepting and release the endpoint. The unix impl unlinks its socket file here so a
   *  racing `connect()` gets `ECONNREFUSED`/`ENOENT` → the convergence recovery path (§2c). */
  close(): Promise<void>;
}

/** The transport factory — the seam both peers depend on. `listen`/`connect` reject with the
 *  underlying error (its `.code` preserved: `EADDRINUSE`/`ECONNREFUSED`/`ENOENT`) so the
 *  bind-or-connect convergence (§19) can branch; callers translate to honest failures. */
export interface Transport {
  /** Bind the endpoint and start accepting. Rejects `EADDRINUSE` if another daemon holds it. */
  listen(): Promise<TransportServer>;
  /** Connect to an existing endpoint. Rejects `ENOENT`/`ECONNREFUSED` when no live daemon. */
  connect(): Promise<TransportConnection>;
}
