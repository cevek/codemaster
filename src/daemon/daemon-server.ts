// The daemon process's front door (spec-daemon-singleton §2/§3). One long-lived process hosts a
// single in-process orchestrator (the warm LS, shared across all bridges — the amortization §2
// promises), binds the unix socket, and routes NDJSON op/status requests to the orchestrator. It
// ONLY routes: each request is dispatched on its own async task, so a heavy op on one connection
// never blocks accepting or serving another (ARCHITECTURE.md §8).
//
// Lifecycle (§3): an open bridge connection is a "hold" (via `createIdleExit`); the daemon
// idle-self-exits only with ZERO open connections after the TTL, closing the listener (which
// unlinks the socket → a racing connect gets ECONNREFUSED → recovery) and disposing the engines.
// This subsumes the Stage-1 server-level idle-exit at the daemon level. A permanently-wedged
// synchronous loop is NOT reaped here (its own idle loop is wedged) — that is a process-mode /
// kill-on-deadline concern (§9, out of scope), the same boundary Stage 1 drew.

import process from 'node:process';
import type { Clock } from '../common/async/clock.ts';
import { messageOfThrown } from '../common/result/construct.ts';
import type { JsonValue } from '../core/json.ts';
import { createIdleExit } from '../common/async/idle-exit.ts';
import type { Transport, TransportConnection } from '../support/transport/seam.ts';
import type { OrchestratorApi } from './orchestrator-api.ts';
import { parseWireRequest, type WireReply } from './protocol.ts';

export interface DaemonServerDeps {
  orchestrator: OrchestratorApi;
  transport: Transport;
  clock: Clock;
  /** Idle-exit TTL (ms) — zero connections for this long → self-exit. */
  idleMs: number;
  /** Injected for tests (assert the exit code without killing the runner). */
  exit?: (code: number) => void;
  /** Optional trace sink (the `daemon` debug ns); default no-op. */
  trace?: (message: string, fields?: () => Record<string, unknown>) => void;
}

export interface DaemonHandle {
  readonly address: string;
  /** Stop accepting, unlink the socket, dispose engines, then call `exit(0)`. Idempotent — the
   *  idle timer and every signal route through it. */
  shutdown(): Promise<void>;
}

export async function serveDaemon(deps: DaemonServerDeps): Promise<DaemonHandle> {
  const trace = deps.trace ?? ((): void => undefined);
  const exit = deps.exit ?? ((code: number): void => process.exit(code));
  const server = await deps.transport.listen();

  let shuttingDown = false;
  const idle = createIdleExit({
    clock: deps.clock,
    idleMs: deps.idleMs,
    onIdle: () => void shutdown(),
  });

  async function shutdown(): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;
    idle.stop();
    // Close the listener FIRST (unlinks the socket) so a racing connect hits the recovery path,
    // then dispose the engines. Both wrapped — a teardown failure must not crash the exit (§3.6).
    await server
      .close()
      .catch((thrown: unknown) =>
        trace('close failed', () => ({ error: messageOfThrown(thrown) })),
      );
    await deps.orchestrator
      .dispose()
      .catch((thrown: unknown) =>
        trace('dispose failed', () => ({ error: messageOfThrown(thrown) })),
      );
    exit(0);
  }

  server.onConnection((connection) => {
    // An open connection holds the daemon alive; the last disconnect re-arms the idle deadline.
    idle.enter();
    let left = false;
    const release = (): void => {
      if (left) return;
      left = true;
      idle.leave();
    };
    connection.onClose(release);
    connection.onError((err) => trace('connection error', () => ({ error: err.message })));
    // Fire-and-forget per message: routing must never block the accept loop or sibling requests.
    connection.onMessage((raw) => void handle(connection, raw));
  });

  async function handle(connection: TransportConnection, raw: JsonValue): Promise<void> {
    const parsed = parseWireRequest(raw);
    if (!parsed.ok) {
      send(connection, {
        id: idOf(raw),
        kind: 'error',
        message: `bad request envelope: ${parsed.error}`,
      });
      return;
    }
    const req = parsed.value;
    try {
      const sourceStale = deps.orchestrator.sourceStale();
      if (req.kind === 'status') {
        const view = await deps.orchestrator.status(req.cwd, req.root);
        send(connection, { id: req.id, kind: 'status', sourceStale, view });
      } else {
        const outcome = await deps.orchestrator.request(req.cwd, req.root, req.reqs, req.batch);
        send(connection, { id: req.id, kind: 'request', sourceStale, outcome });
      }
    } catch (thrown) {
      // §3.6 — a routing/op crash is an honest error reply, never a daemon-down or a hang.
      send(connection, { id: req.id, kind: 'error', message: messageOfThrown(thrown) });
    }
  }

  // SIGTERM/SIGINT → graceful shutdown (the eviction path, §19); the idle timer is the belt.
  process.on('SIGTERM', () => void shutdown());
  process.on('SIGINT', () => void shutdown());

  // Arm immediately: a daemon nobody ever connects to still idle-exits after the TTL.
  idle.start();
  trace('daemon listening', () => ({ address: server.address }));
  return { address: server.address, shutdown };
}

function send(connection: TransportConnection, reply: WireReply): void {
  connection.send(reply as unknown as JsonValue);
}

/** Best-effort id recovery from an unvalidated envelope, so even a malformed request gets a
 *  correlatable error reply rather than a silent drop. */
function idOf(raw: JsonValue): number {
  if (typeof raw === 'object' && raw !== null && !Array.isArray(raw)) {
    const id = (raw as { [k: string]: JsonValue })['id'];
    if (typeof id === 'number') return id;
  }
  return 0;
}
