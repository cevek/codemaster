// The watchdog worker thread (backstop 1, t-095661). It runs on its OWN thread with a real timer,
// so it keeps ticking even when the MAIN thread is wedged in a synchronous busy-loop — where the
// event loop is dead and signals / JS handlers / process.report are all unserviceable (established
// empirically on the live incident: only a separate thread or external process can act). Each tick
// it reads the main thread's SharedArrayBuffer breadcrumb; on a wedge (busy past the threshold) — or
// on an orphaned in-process server — it writes the breadcrumb to `~/.codemaster/stalls/` then
// SIGKILLs the whole process.
//
// SIGKILL, not abort/exit: `process.abort()` is UNSUPPORTED in a worker (ERR_WORKER_UNSUPPORTED_
// OPERATION), and `process.exit` exits only the worker. `process.kill(process.pid, 'SIGKILL')` is
// kernel-delivered and uncatchable — it bypasses the wedged JS loop entirely (verified).

import { parentPort, workerData } from 'node:worker_threads';
import process from 'node:process';
import { readBeacon, viewsOf, isWedged } from './beacon-sab.ts';
import { writeStallRecord } from './stall-dir.ts';
import { isOrphaned, processAlive } from './orphan-poll.ts';

interface WatchdogWorkerData {
  sab: SharedArrayBuffer;
  thresholdMs: number;
  pollMs: number;
  stallDir: string;
  /** The spawning parent pid to watch for the in-process path; `null` disables orphan-kill (the
   *  daemon is detached by design — its parent legitimately becomes init). */
  orphanParent: number | null;
}

// Grace before the worker SIGKILLs a healthy orphan: give the main-loop orphan poll (backstop 2) a
// chance to shut down gracefully first. A WEDGED orphan never lets that poll fire, so the worker
// reaps it after the grace.
const ORPHAN_GRACE_TICKS = 2;

const data = workerData as WatchdogWorkerData;
const views = viewsOf(data.sab);
let orphanTicks = 0;

function reap(reason: 'wedge' | 'orphan', op: string, startMs: number, seq: number): void {
  const ts = Date.now();
  writeStallRecord(data.stallDir, {
    reason,
    pid: process.pid,
    op,
    startMs,
    elapsedMs: startMs > 0 ? ts - startMs : 0,
    seq,
    ts,
  });
  process.kill(process.pid, 'SIGKILL');
}

function tick(): void {
  const now = Date.now();
  const snap = readBeacon(views);
  if (isWedged(snap, now, data.thresholdMs)) {
    reap('wedge', snap.text, snap.startMs, snap.seq);
    return;
  }
  if (data.orphanParent !== null && isOrphaned(data.orphanParent, processAlive)) {
    orphanTicks += 1;
    if (orphanTicks >= ORPHAN_GRACE_TICKS) {
      reap('orphan', snap.busy ? snap.text : '(orphaned)', snap.startMs, snap.seq);
    }
  } else {
    orphanTicks = 0;
  }
}

const timer = setInterval(tick, data.pollMs);

// The parent can stop the worker cleanly (normal shutdown). The interval (NOT unref'd here) keeps
// the worker thread alive; `installWatchdog` unrefs the WORKER handle so it never holds the main
// process open past its own work.
parentPort?.on('message', (message) => {
  if (message === 'stop') {
    clearInterval(timer);
    parentPort?.close();
  }
});
