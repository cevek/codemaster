// Bind-or-connect convergence (spec-daemon-singleton §2/§19): every `codemaster mcp` bridge
// converges on one daemon. Try to connect; if none answers, RE-PROBE (a second connect — the §19
// liveness probe) right before clearing the socket, so we only unlink a genuinely STALE file
// (ENOENT = none; ECONNREFUSED = a SIGKILLed daemon's leftover), never a daemon another bridge just
// bound; then spawn and poll-connect within a bounded budget. A launch race resolves at the daemon's
// bind (the loser gets EADDRINUSE and exits, both bridges connect to the winner). A narrow residual
// race remains — the re-probe can miss a daemon that binds in the microsecond after it — but it
// self-heals: the orphaned daemon idle-exits by TTL (convergence hardening tracked in backlog).
//
// Never-hang (§1): connect attempts and the spawn-wait are bounded by a deadline → return
// `undefined` so the caller falls back to in-process serving (Stage-1 behavior), never a spin.

import * as fs from 'node:fs';
import type { Clock } from '../common/async/clock.ts';
import { messageOfThrown } from '../common/result/construct.ts';
import type { Transport, TransportConnection } from '../support/transport/seam.ts';

export interface ConnectOrSpawnDeps {
  transport: Transport;
  socketPath: string;
  /** Fire the detached daemon spawn (injectable so tests start an in-process daemon instead). */
  spawnDaemon: () => void;
  clock: Clock;
  /** Total budget to obtain a connection after spawning (ms). Default 5000. */
  spawnTimeoutMs?: number;
  /** Poll interval while waiting for the spawned daemon to bind (ms). Default 25. */
  pollIntervalMs?: number;
  trace?: (message: string, fields?: () => Record<string, unknown>) => void;
}

/** Resolve a connection to the singleton daemon, or `undefined` if one can't be reached within the
 *  budget (→ the bridge falls back to in-process). */
export async function connectOrSpawnDaemon(
  deps: ConnectOrSpawnDeps,
): Promise<TransportConnection | undefined> {
  const trace = deps.trace ?? ((): void => undefined);

  const existing = await tryConnect(deps.transport);
  if (existing !== undefined) return existing;

  // Re-probe before clearing the socket (§19 liveness probe): between the first probe and now,
  // another bridge may have bound a LIVE daemon. If it answers, use it — never unlink a live socket.
  const reprobe = await tryConnect(deps.transport);
  if (reprobe !== undefined) return reprobe;

  // Confirmed no live daemon. Remove a stale socket file (a SIGKILLed daemon's leftover) so the
  // spawned daemon can bind a fresh endpoint, then spawn and wait — bounded.
  unlinkIfExists(deps.socketPath, trace);
  trace('spawning daemon', () => ({ socket: deps.socketPath }));
  deps.spawnDaemon();

  // Hold the event loop open across the spawn-wait: the spawned daemon is detached+unref'd and the
  // Clock's poll timers are unref'd, so without this REF'd keep-alive Node would see nothing pending
  // and exit 0 mid-wait. Cleared on every exit path.
  const keepAlive = setInterval(() => undefined, 1000);
  try {
    const budget = deps.spawnTimeoutMs ?? 5000;
    const interval = deps.pollIntervalMs ?? 25;
    const deadline = deps.clock.now() + budget;
    for (;;) {
      const conn = await tryConnect(deps.transport);
      if (conn !== undefined) return conn;
      if (deps.clock.now() >= deadline) {
        trace('daemon spawn-wait exhausted', () => ({ budget }));
        return undefined;
      }
      await delay(deps.clock, interval);
    }
  } finally {
    clearInterval(keepAlive);
  }
}

/** One fail-fast connect attempt: a live daemon → a connection; no/stale socket (ENOENT /
 *  ECONNREFUSED) or any connect error → `undefined`. Shared with the management verbs
 *  (spec-daemon-cli) so "is a daemon up?" is probed identically everywhere. */
export async function tryConnect(transport: Transport): Promise<TransportConnection | undefined> {
  try {
    return await transport.connect();
  } catch {
    // ENOENT (no socket) / ECONNREFUSED (stale) / any connect error → no daemon yet.
    return undefined;
  }
}

function unlinkIfExists(
  socketPath: string,
  trace: (m: string, f?: () => Record<string, unknown>) => void,
): void {
  try {
    fs.unlinkSync(socketPath);
  } catch (thrown) {
    const code = (thrown as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT')
      trace('stale-socket unlink failed', () => ({ error: messageOfThrown(thrown) }));
  }
}

function delay(clock: Clock, ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    clock.schedule(ms, resolve);
  });
}
