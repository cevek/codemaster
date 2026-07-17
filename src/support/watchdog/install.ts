// Install the never-hang watchdog (t-095661) — main-thread side. Spins up the worker thread that
// reaps a wedged main loop (backstop 1) and, on the in-process path, the main-loop orphan poll
// (backstop 2). Wire it at the composition root (`bin.ts`) on the two paths that host an in-process
// orchestrator with no external killer: `mcp --in-process` (orphan-aware) and `daemon serve`
// (wedge-only — the daemon is detached, and its production hard-guarantee is §9 kill-on-deadline).
//
// BEST-EFFORT: any failure to arm the watchdog returns a no-op handle and never touches the serve
// path — a broken watchdog must not break serving. It is a backstop, not a dependency.

import process from 'node:process';
import { Worker } from 'node:worker_threads';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Clock } from '../../common/async/clock.ts';
import { beacon } from './beacon.ts';
import { SAB_BYTES } from './beacon-sab.ts';
import { startOrphanPoll } from './orphan-poll.ts';

const DEFAULT_THRESHOLD_MS = 5 * 60_000; // §1: no legitimate op approaches 5 min → no false-positive
const DEFAULT_POLL_MS = 5_000;

export interface InstallWatchdogOptions {
  clock: Clock;
  /** Watch the spawning parent and self-exit when it dies (the `mcp --in-process` path). Off for
   *  the detached daemon. */
  orphanAware: boolean;
  /** Fired by the orphan poll (default: SIGTERM self → the server's graceful shutdown). Injectable
   *  so a test asserts the trigger without terminating the runner. */
  onOrphan?: () => void;
  /** Failure sink (default no-op) — the watchdog never writes to stdout (§13). */
  log?: (message: string) => void;
}

export interface WatchdogHandle {
  stop(): void;
}

const NOOP_HANDLE: WatchdogHandle = { stop: () => undefined };

/** Arm the watchdog. Returns a handle whose `stop()` tears down the worker + poll (best-effort;
 *  the unref'd worker also dies with the process on a normal exit). */
export function installWatchdog(options: InstallWatchdogOptions): WatchdogHandle {
  const log = options.log ?? ((): void => undefined);
  if (readEnvFlag('CODEMASTER_WATCHDOG') === '0') return NOOP_HANDLE;

  try {
    const thresholdMs = readEnvMs('CODEMASTER_WATCHDOG_MS', DEFAULT_THRESHOLD_MS);
    const pollMs = readEnvMs('CODEMASTER_WATCHDOG_POLL_MS', DEFAULT_POLL_MS);
    const stallDir = resolveStallDir();
    // The parent whose lifetime owned ours (the MCP host). <= 1 means we were launched already
    // detached — nothing to orphan-watch, so disable rather than watch init forever.
    const parentAtStart = process.ppid;
    const watchParent = options.orphanAware && parentAtStart > 1;

    const sab = new SharedArrayBuffer(SAB_BYTES);
    beacon.bind(sab, options.clock);

    const worker = new Worker(new URL('./worker.ts', import.meta.url), {
      workerData: {
        sab,
        thresholdMs,
        pollMs,
        stallDir,
        orphanParent: watchParent ? parentAtStart : null,
      },
    });
    // The worker must never hold the main process open past its own work, and its errors must never
    // escape as uncaught (§3.6) — a dead watchdog degrades to "no backstop", never a crash.
    worker.unref();
    worker.on('error', (err) => log(`watchdog worker error: ${err.message}`));

    const stopOrphanPoll = watchParent
      ? startOrphanPoll({
          clock: options.clock,
          parentAtStart,
          pollMs,
          onOrphan: options.onOrphan ?? defaultOnOrphan,
        })
      : undefined;

    return {
      stop: () => {
        try {
          stopOrphanPoll?.();
          worker.postMessage('stop');
          void worker.terminate();
          beacon.reset();
        } catch {
          /* teardown is best-effort */
        }
      },
    };
  } catch (thrown) {
    beacon.reset();
    log(`watchdog install failed: ${thrown instanceof Error ? thrown.message : String(thrown)}`);
    return NOOP_HANDLE;
  }
}

/** Default orphan action: SIGTERM ourselves so the server's existing handler shuts down gracefully
 *  (dispose engines + exit). If the loop is wedged this signal is unserviceable — the worker's
 *  orphan branch then SIGKILLs as the backstop. */
function defaultOnOrphan(): void {
  try {
    process.kill(process.pid, 'SIGTERM');
  } catch {
    /* nothing more we can do from here */
  }
}

function resolveStallDir(): string {
  const override = readEnvFlag('CODEMASTER_STALL_DIR');
  if (override !== undefined && override.length > 0) return override;
  return path.join(homeDir(), '.codemaster', 'stalls');
}

/** Env-independent home (passwd), mirroring `socket-path.ts` — the stall dir must resolve the same
 *  whether spawned by a stripped-env host or a normal shell. */
function homeDir(): string {
  try {
    return os.userInfo().homedir;
  } catch {
    return os.tmpdir();
  }
}

function readEnvFlag(name: string): string | undefined {
  return process.env[name];
}

function readEnvMs(name: string, fallback: number): number {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw > 0 ? raw : fallback;
}
