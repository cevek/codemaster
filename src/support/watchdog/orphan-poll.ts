// Orphan detection + the main-loop orphan poll (backstop 2, t-095661). An `mcp --in-process` server
// whose MCP host exits is reparented (to launchd/init on POSIX) and — pre-incident — kept spinning
// as a 100% CPU zombie. stdin-EOF normally catches this, but the getppid poll is a cheap belt for a
// missed EOF: it self-exits when the process that spawned us is gone.
//
// Detection is a process-EXISTENCE probe on the spawning parent (`kill(pid, 0)`), NOT the cached
// `process.ppid` — `kill(pid, 0)` is always live (ESRCH ⇒ gone, EPERM ⇒ alive-but-not-ours). PID
// reuse is a negligible false-negative window bounded by the poll interval. This is the DEV/
// in-process path only: the daemon (`daemon serve`) is DETACHED by design (its parent legitimately
// becomes init), so orphan-exit is disabled there — `installWatchdog` passes `orphanParent: null`.

import process from 'node:process';
import type { Clock } from '../../common/async/clock.ts';

/** Is the process that spawned us gone? `probe` is process-existence; injected for tests. */
export function isOrphaned(parentAtStart: number, probe: (pid: number) => boolean): boolean {
  return !probe(parentAtStart);
}

/** Default existence probe: `kill(pid, 0)` sends no signal, only checks reachability. ESRCH ⇒ the
 *  pid is gone; EPERM ⇒ it exists under another user (alive); any other error ⇒ treat as alive
 *  (conservative — never a false orphan-kill). */
export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (thrown) {
    return (thrown as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export interface OrphanPollOptions {
  clock: Clock;
  /** The pid to watch — captured at install (the MCP host). */
  parentAtStart: number;
  pollMs: number;
  /** Fired once when the parent is found gone; the poll then stops. */
  onOrphan: () => void;
  /** Existence probe seam (tests inject a fake); defaults to `processAlive`. */
  probe?: (pid: number) => boolean;
}

/** Start a repeating orphan check on the MAIN loop. Returns a stop function. When the loop is
 *  wedged this never fires (that is the worker's job — backstop 1); this handles the healthy
 *  orphan, gracefully. */
export function startOrphanPoll(options: OrphanPollOptions): () => void {
  const probe = options.probe ?? processAlive;
  let cancel: (() => void) | undefined;
  let stopped = false;
  const schedule = (): void => {
    if (stopped) return;
    cancel = options.clock.schedule(options.pollMs, () => {
      if (stopped) return;
      if (isOrphaned(options.parentAtStart, probe)) {
        stopped = true;
        options.onOrphan();
        return;
      }
      schedule();
    });
  };
  schedule();
  return (): void => {
    stopped = true;
    cancel?.();
  };
}
