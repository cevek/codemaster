// Force-recover a WEDGED daemon (t-000051). The management verbs (`daemon stop|restart`) first ask
// the daemon to exit gracefully (the `shutdown` control-message); when that goes unanswered past the
// deadline the daemon's front door is wedged (a sync-spin, or — in the default in-process mode — a
// heavy op blocking the shared loop) and can only be reaped from OUTSIDE. This escalates: read the
// kill-target-hint pidfile the daemon dropped at bind, SIGTERM→(grace)→SIGKILL that pid, confirm it
// is gone, and drop the stale pidfile.
//
// Distinct from B1 (process-host child-kill, t-000052): that reaps a wedged ENGINE CHILD on a
// per-request deadline; this reaps the DAEMON PROCESS itself on an explicit verb — different target,
// different trigger, not a duplicate.
//
// The pidfile is a KILL-TARGET HINT, never a liveness authority (§3.5): the socket already proved
// unresponsive; the pidfile only says WHICH pid to signal. Anti-recycle guard: the pidfile must name
// THIS endpoint (socket-identity), the pid must be alive, and the file is RE-READ immediately before
// BOTH signals — SIGTERM AND SIGKILL — because the grace between them can span a recycle (a daemon
// that honors SIGTERM exits and removes its own pidfile, freeing the pid for reuse). Each read that
// finds the hint gone/changed aborts rather than signalling a possibly-innocent pid. A narrow TOCTOU
// window still remains — a recycle between the last read and the signal itself — mirroring the
// convergence "narrow residual race" (§19); it is disclosed, not hidden. Socket-unlink + respawn are
// deliberately NOT done here: the caller routes respawn through `connectOrSpawnDaemon`, whose
// re-probe is what keeps a sibling's freshly-bound daemon from being unlinked (the convergence
// invariant).

import type { Clock } from '../common/async/clock.ts';
import { readPidfile as defaultReadPidfile } from '../support/pidfile/read.ts';
import { removePidfile as defaultRemovePidfile } from '../support/pidfile/write.ts';
import {
  isProcessAlive as defaultIsAlive,
  sendSignal as defaultSendSignal,
  type SignalOutcome,
} from '../support/pidfile/liveness.ts';
import type { PidfileRecord } from '../support/pidfile/write.ts';

export interface ForceRecoverDeps {
  /** The socket this verb manages — cross-checked against the pidfile's `socket` (identity guard). */
  socketPath: string;
  pidfilePath: string;
  clock: Clock;
  /** Grace after SIGTERM before escalating to SIGKILL (ms). */
  termGraceMs?: number;
  /** Budget to confirm the process gone after SIGKILL (ms). */
  killConfirmMs?: number;
  /** Poll interval while waiting on liveness transitions (ms). */
  pollIntervalMs?: number;
  // Seams (default to the real pidfile/liveness primitives) — injected for deterministic tests.
  readPidfile?: (p: string) => PidfileRecord | undefined;
  isAlive?: (pid: number) => boolean;
  signal?: (pid: number, sig: NodeJS.Signals) => SignalOutcome;
  removePidfile?: (p: string) => void;
}

export type ForceRecoverResult =
  /** Signalled and confirmed gone. */
  | { kind: 'killed'; pid: number }
  /** The target pid was already gone — the wedge resolved on its own; stale hint cleared. */
  | { kind: 'already-gone'; pid: number }
  /** No trustworthy hint (absent / invalid / for a different socket) — caller falls back to the
   *  honest manual-kill guidance. */
  | { kind: 'no-target'; reason: string }
  /** The pidfile changed under us (another actor recovered, or a new daemon rebound) — abort the
   *  kill; caller re-probes rather than signalling a possibly-innocent pid. */
  | { kind: 'target-changed' }
  /** Signalled but the process did not vanish within the budget — caller reports honestly. */
  | { kind: 'still-alive'; pid: number };

const DEFAULT_TERM_GRACE_MS = 2000;
const DEFAULT_KILL_CONFIRM_MS = 2000;
const DEFAULT_POLL_MS = 25;

/** Kill a wedged daemon named by the pidfile, guarded against recycled/mismatched pids. Bounded at
 *  every step (§1 never-hang) — no unbounded poll. Never throws. */
export async function forceRecoverDaemon(deps: ForceRecoverDeps): Promise<ForceRecoverResult> {
  // Hold the event loop open across the poll: the real `Clock`'s timers are `unref`ed, and by now the
  // caller has closed the wedged connection, so without a REF'd keep-alive Node would see nothing
  // pending and exit 0 mid-wait — abandoning the SIGKILL (same guard as connectOrSpawnDaemon).
  const keepAlive = setInterval(() => undefined, 1000);
  try {
    return await recover(deps);
  } finally {
    clearInterval(keepAlive);
  }
}

async function recover(deps: ForceRecoverDeps): Promise<ForceRecoverResult> {
  const readPidfile = deps.readPidfile ?? defaultReadPidfile;
  const isAlive = deps.isAlive ?? defaultIsAlive;
  const signal = deps.signal ?? defaultSendSignal;
  const removePidfile = deps.removePidfile ?? defaultRemovePidfile;
  const pollMs = deps.pollIntervalMs ?? DEFAULT_POLL_MS;

  const rec = readPidfile(deps.pidfilePath);
  if (rec === undefined) return { kind: 'no-target', reason: 'no usable pidfile hint' };
  if (rec.socket !== deps.socketPath)
    return { kind: 'no-target', reason: 'pidfile names a different socket' };
  const pid = rec.pid;
  if (!isAlive(pid)) {
    removePidfile(deps.pidfilePath); // stale leftover — the daemon already died.
    return { kind: 'already-gone', pid };
  }

  // Re-read immediately before signalling — the anti-recycle/anti-race guard. If the hint changed
  // pid (another actor acted, or a new daemon rebound), do NOT kill: the pid we hold may no longer
  // be the wedged daemon.
  const confirm = readPidfile(deps.pidfilePath);
  if (confirm === undefined || confirm.pid !== pid) return { kind: 'target-changed' };

  signal(pid, 'SIGTERM');
  // A sync-spin can't service SIGTERM's handler, so the grace usually elapses and SIGKILL is the
  // real backstop (§1); a merely-slow-but-alive daemon that DOES honor SIGTERM exits within it.
  if (
    await waitUntilGone(pid, deps.termGraceMs ?? DEFAULT_TERM_GRACE_MS, pollMs, deps.clock, isAlive)
  ) {
    removePidfile(deps.pidfilePath);
    return { kind: 'killed', pid };
  }

  // SECOND re-read guard, before the harder SIGKILL. The grace above can span a fresh recycle: a
  // daemon that HONORED SIGTERM removes its OWN pidfile on graceful exit (the alternative to the
  // sync-spin the comment above flags), so a gone/changed hint here means SIGTERM already worked and
  // the still-"alive" pid is a recycled INNOCENT process — never SIGKILL it. `undefined` (graceful
  // exit, no new daemon yet) → the wedge is gone; a changed pid → a new daemon rebound. In neither
  // case do we remove the pidfile (it's already gone, or belongs to the new daemon).
  const beforeKill = readPidfile(deps.pidfilePath);
  if (beforeKill === undefined) return { kind: 'killed', pid };
  if (beforeKill.pid !== pid) return { kind: 'target-changed' };

  // A SIGKILL that can't be delivered (EPERM) means the pid is now owned by another user — a recycle
  // to a foreign process; abort rather than advise `kill -9` on it. (ESRCH → already gone → the poll
  // below settles it as killed.)
  if (signal(pid, 'SIGKILL') === 'error') return { kind: 'target-changed' };
  if (
    await waitUntilGone(
      pid,
      deps.killConfirmMs ?? DEFAULT_KILL_CONFIRM_MS,
      pollMs,
      deps.clock,
      isAlive,
    )
  ) {
    removePidfile(deps.pidfilePath);
    return { kind: 'killed', pid };
  }
  return { kind: 'still-alive', pid };
}

/** Poll `isAlive(pid)` until it reports gone or `budgetMs` elapses. Returns whether it went gone.
 *  Bounded — the deadline is the hard stop, never an unbounded spin. */
async function waitUntilGone(
  pid: number,
  budgetMs: number,
  pollMs: number,
  clock: Clock,
  isAlive: (pid: number) => boolean,
): Promise<boolean> {
  const deadline = clock.now() + budgetMs;
  for (;;) {
    if (!isAlive(pid)) return true;
    if (clock.now() >= deadline) return false;
    await delay(clock, pollMs);
  }
}

function delay(clock: Clock, ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    clock.schedule(ms, resolve);
  });
}
