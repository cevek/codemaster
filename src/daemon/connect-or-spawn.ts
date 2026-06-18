// Bind-or-connect convergence (spec-daemon-singleton §2/§19): every `codemaster mcp` bridge ends up
// talking to exactly ONE daemon. Try to connect; if there's no live daemon (ENOENT = no socket;
// ECONNREFUSED = a stale socket from a SIGKILLed daemon), unlink any stale file, spawn a daemon, and
// poll-connect within a bounded budget. A launch race resolves at the daemon's bind: the loser
// daemon gets EADDRINUSE and exits, both bridges poll-connect onto the winner.
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

  // No live daemon. Remove a stale socket file (ECONNREFUSED left it behind) so the spawned daemon
  // can bind a fresh endpoint, then spawn and wait — bounded.
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

async function tryConnect(transport: Transport): Promise<TransportConnection | undefined> {
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
