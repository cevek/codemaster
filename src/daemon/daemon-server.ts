// The daemon process's front door (spec-daemon-singleton §2/§3). One long-lived process hosts a
// single in-process orchestrator (the warm LS, shared across all bridges — the amortization §2
// promises), binds the unix socket, and routes NDJSON op/status requests to the orchestrator. It
// ONLY routes: each request is dispatched on its own async task, so a heavy op on one connection
// never blocks accepting or serving another (ARCHITECTURE.md §8).
//
// Lifecycle (§3): an open bridge connection is a "hold" (via `createIdleExit`); the daemon
// idle-self-exits only with ZERO open connections after the TTL, closing the listener (which
// unlinks the socket → a racing connect gets ECONNREFUSED → recovery) and disposing the engines.
// This subsumes the Stage-1 server-level idle-exit at the daemon level. A permanently-wedged front
// door (a sync-spin holding the socket, or — in the default in-process mode — a heavy op blocking
// the shared loop) is NOT reaped from inside: its own idle loop is wedged too. Recovery is EXTERNAL
// (spec-daemon-cli / t-000051): the daemon drops a pidfile next to the socket at bind, so the
// management verbs (`daemon stop|restart`) can pidfile-target a SIGTERM→SIGKILL when the graceful
// shutdown-message goes unanswered. The pidfile is a KILL-TARGET HINT only — the socket stays the
// sole liveness oracle (§3.5); it is written AFTER a successful bind (so a bind-race loser leaves
// none) and removed on graceful shutdown (so a lingering pidfile means a daemon that never exited
// cleanly — exactly the wedge the recovery targets).

import process from 'node:process';
import type { Clock } from '../common/async/clock.ts';
import { messageOfThrown } from '../common/result/construct.ts';
import type { JsonValue } from '../core/json.ts';
import { createIdleExit } from '../common/async/idle-exit.ts';
import type { Transport, TransportConnection } from '../support/transport/seam.ts';
import { writePidfile, removePidfile } from '../support/pidfile/write.ts';
import { capOpNames } from '../common/truncate/cap-op-names.ts';
import { noopUsageLogger } from '../support/usage-log/create.ts';
import type { InflightCall, InflightHandle, UsageLogger } from '../support/usage-log/entry.ts';
import type { ServingOrchestrator } from './orchestrator-api.ts';
import { parseWireRequest, type WireRequest, type WireReply } from './protocol.ts';

export interface DaemonServerDeps {
  orchestrator: ServingOrchestrator;
  transport: Transport;
  clock: Clock;
  /** Idle-exit TTL (ms) — zero connections for this long → self-exit. */
  idleMs: number;
  /** Where to drop this daemon's kill-target-hint pidfile (t-000051), and the facts it carries.
   *  Written after a successful bind, removed on graceful shutdown. Omitted by tests that don't
   *  exercise recovery (no file is touched). */
  pidfile?: { path: string; socket: string; version: string };
  /** Crash-breadcrumb sink for the daemon's OWN dispatch (§13). The daemon is NOT the owner of call
   *  accounting — the agent-facing process (bridge / `--in-process` / fallback) writes the one
   *  record per call, and this logger's `record` is never called for a request — so wiring it adds
   *  no second count. It exists for the one thing that process cannot produce: a daemon fatal
   *  attributed to the op that was running (see `withBreadcrumb`). Library default is a no-op, so
   *  tests touch no disk; the composition root (bin.ts `daemon serve`) injects the real one. */
  usage?: UsageLogger;
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

const NOOP_INFLIGHT: InflightHandle = { clear: () => undefined };

export async function serveDaemon(deps: DaemonServerDeps): Promise<DaemonHandle> {
  const trace = deps.trace ?? ((): void => undefined);
  const exit = deps.exit ?? ((code: number): void => process.exit(code));
  const server = await deps.transport.listen();

  // Bind succeeded (a bind-race loser threw above and never reaches here), so this process owns the
  // socket → drop the kill-target-hint pidfile (t-000051). Wrapped inside writePidfile → a write
  // failure is an honest no-hint, never a crash of the serve path (§3.6).
  if (deps.pidfile !== undefined) {
    writePidfile(deps.pidfile.path, {
      pid: process.pid,
      socket: deps.pidfile.socket,
      version: deps.pidfile.version,
      startedAt: deps.clock.now(),
    });
  }

  const usage = deps.usage ?? noopUsageLogger;
  /** Every breadcrumb currently on disk for a dispatch this daemon is running. A GRACEFUL exit
   *  clears them all before `exit(0)` (see `shutdown`), which is what makes "a clean exit leaves no
   *  breadcrumb" a structural fact rather than a timing accident — and therefore what makes a
   *  promoted `origin:'daemon'` record mean a FATAL. */
  const live = new Set<InflightHandle>();

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
    // Clear every in-flight breadcrumb FIRST. `shutdown` does not (and must not) drain dispatches —
    // an unbounded wait would make a wedged op block the exit forever, and `daemon stop` exists
    // precisely to recover a wedged daemon (§1 never-hang). So the calls in flight really do die
    // here; what must NOT happen is their breadcrumbs outliving a CLEAN exit and being promoted as
    // fatals, which would make `origin:'daemon'` fire on every `codemaster daemon restart` — the
    // command CONTRIBUTING tells agents to run after each edit. Those calls are not lost: the
    // agent-facing process still writes its own record for each, which is exactly the ownership
    // split. Bounded — one unlink per live call — and best-effort per handle.
    for (const handle of live) {
      try {
        handle.clear();
      } catch {
        /* one failed unlink must not stop the teardown */
      }
    }
    live.clear();
    // Close the listener FIRST (unlinks the socket) so a racing connect hits the recovery path,
    // then dispose the engines. Both wrapped — a teardown failure must not crash the exit (§3.6).
    await server
      .close()
      .catch((thrown: unknown) =>
        trace('close failed', () => ({ error: messageOfThrown(thrown) })),
      );
    // Graceful exit → drop the kill-target hint (best-effort, never throws). A lingering pidfile
    // now unambiguously marks a daemon that did NOT exit cleanly — the wedge recovery targets.
    if (deps.pidfile !== undefined) removePidfile(deps.pidfile.path);
    await deps.orchestrator
      .dispose()
      .catch((thrown: unknown) =>
        trace('dispose failed', () => ({ error: messageOfThrown(thrown) })),
      );
    // Release the breadcrumb sink's file handles, mirroring `serveMcp`'s shutdown. Wrapped:
    // telemetry teardown must never be what stops the daemon from exiting (§3.6).
    try {
      usage.dispose();
    } catch {
      /* best-effort — the process is exiting anyway */
    }
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

  /** Stamp the daemon's own crash breadcrumb around ONE dispatched request and clear it when the
   *  dispatch returns — `begin`/`clear` only, never `record` (see the `usage` dep).
   *
   *  Why the daemon needs this at all: when the daemon dies mid-call the BRIDGE survives, so it
   *  writes an ordinary `ok:false` / "daemon connection closed" record — a fatal that reads like a
   *  transport hiccup, invisible to triage filtering on `outcome:'crash'`. A breadcrumb left here is
   *  promoted at the next logger start as `outcome:'crash', origin:'daemon'`, naming the op that was
   *  actually running. That is PROOF (the daemon's pid is gone AND the call was in flight), not the
   *  pidfile inference §3.5 forbids.
   *
   *  Wrapped end to end: telemetry must never surface on the request path (§3.6). */
  async function withBreadcrumb<T>(call: InflightCall, run: () => Promise<T>): Promise<T> {
    let inflight: InflightHandle = NOOP_INFLIGHT;
    try {
      inflight = usage.begin(call);
      live.add(inflight);
    } catch {
      /* telemetry must never crash the daemon */
    }
    try {
      return await run();
    } finally {
      live.delete(inflight);
      try {
        inflight.clear();
      } catch {
        /* a stale breadcrumb is reconciled at the next start; never a throw here */
      }
    }
  }

  /** What the daemon can honestly say a request WAS.
   *
   *  `ops` is EXACT — the wire carries the op names. `tool` is DERIVED and cannot be exact: the MCP
   *  tool name never crosses the socket, and the wire's `batch` field is not the discriminator it
   *  looks like (`mcp/server.ts` sends it only when the call carries `sql`, so a plain `batch` call
   *  arrives without it and a per-op call WITH `sql` arrives with it). Deriving from it named the
   *  wrong tool in BOTH directions, so the honest derivation is the request COUNT: >1 request can
   *  only be a batch. The one case the wire cannot distinguish — a batch of exactly one request vs
   *  a per-op call — reads as the op name; `ops` is unaffected either way, which is why triage and
   *  the correlation recipe key on `cwd + ops`, not on `tool`.
   *
   *  `cwd` is the CLIENT's, off the wire — never the detached daemon's own `process.cwd()`, which
   *  would name the wrong repo in triage. */
  function describe(req: Extract<WireRequest, { kind: 'request' | 'status' }>): InflightCall {
    const ops =
      req.kind === 'status'
        ? []
        : capOpNames(
            req.reqs.map((r) => r.name),
            req.reqs.length,
          );
    const tool =
      req.kind === 'status'
        ? 'status'
        : req.reqs.length === 1
          ? (ops[0] ?? 'request')
          : req.reqs.length === 0
            ? 'request'
            : 'batch';
    return {
      ts: deps.clock.now(),
      tool,
      ops,
      cwd: req.cwd,
      args: req.kind === 'status' ? null : (req.reqs as unknown as JsonValue),
      origin: 'daemon',
    };
  }

  async function handle(connection: TransportConnection, raw: JsonValue): Promise<void> {
    // A dispatch in flight is a HOLD on the idle deadline. The connection-level hold above is
    // released the instant the client disconnects, but this handler is detached from the
    // connection's lifetime (`onMessage` is fire-and-forget) — so without this bracket a client
    // dropping mid-call re-arms the deadline and the daemon can idle-exit with the op still running.
    // That kills a live call, AND it would leave a breadcrumb behind a GRACEFUL exit, making the
    // crash discriminator above fabricate a fatal. Bracketing here makes "an idle-exit cannot happen
    // with a request in flight" structural rather than a timing accident.
    idle.enter();
    try {
      await dispatch(connection, raw);
    } finally {
      idle.leave();
    }
  }

  async function dispatch(connection: TransportConnection, raw: JsonValue): Promise<void> {
    // Refuse anything arriving after teardown began. `shutdown()` clears the live breadcrumbs
    // synchronously and then exits, so a request accepted after that point would stamp a NEW
    // breadcrumb nothing will ever clear — a fatal fabricated behind a clean exit. Reachable when
    // one socket read carries `shutdown` and a request together (they coalesce into a single chunk),
    // which no production client sends today: this gate is what makes the guarantee structural
    // instead of resting on `TransportServer.close()` happening to destroy links synchronously.
    if (shuttingDown) {
      send(connection, { id: idOf(raw), kind: 'error', message: 'daemon is shutting down' });
      return;
    }
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
      if (req.kind === 'shutdown') {
        // No reply: the connection CLOSING (listener torn down, socket unlinked) is the management
        // client's confirmation that the daemon committed to exit (§3 / spec-daemon-cli stop).
        void shutdown();
      } else if (req.kind === 'daemon-info') {
        // A pure read of this daemon's own facts — no cwd, no engine warm (spec-daemon-cli status).
        send(connection, {
          id: req.id,
          kind: 'daemon-info',
          sourceStale,
          info: deps.orchestrator.daemonInfo(),
        });
      } else if (req.kind === 'status') {
        const view = await withBreadcrumb(describe(req), () =>
          deps.orchestrator.status(req.cwd, req.root),
        );
        send(connection, { id: req.id, kind: 'status', sourceStale, view });
      } else {
        const outcome = await withBreadcrumb(describe(req), () =>
          deps.orchestrator.request(req.cwd, req.root, req.reqs, req.batch),
        );
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
