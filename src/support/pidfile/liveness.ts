// Process liveness + signalling primitives for wedged-daemon recovery (t-000051). Pure wrappers
// around `process.kill` — daemon-agnostic, no timing, no kill-ladder policy (that orchestration,
// with its re-read/identity guard, lives in the daemon layer). Both are wrapped so a signalling
// error (a recycled pid we no longer own, a vanished process) never throws into the caller (§3.6).
//
// These operate on a bare pid; the caller is responsible for having proven, via the SOCKET (§3.5),
// that a kill is warranted — a pid alone is never a liveness authority here.

/** Signal 0 probes existence without delivering a signal: no error → the process exists; `ESRCH`
 *  → gone; `EPERM` → exists but owned by another user (still alive). Any other error is treated
 *  conservatively as "unknown → assume gone" so a caller never spins waiting on it. */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (thrown) {
    return (thrown as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export type SignalOutcome = 'sent' | 'noProcess' | 'error';

/** Send `signal` to `pid`. `'sent'` = delivered; `'noProcess'` = already gone (`ESRCH` — the
 *  desired end state for a kill, so the caller treats it as success); `'error'` = anything else
 *  (e.g. `EPERM`). Never throws. */
export function sendSignal(pid: number, signal: NodeJS.Signals): SignalOutcome {
  try {
    process.kill(pid, signal);
    return 'sent';
  } catch (thrown) {
    return (thrown as NodeJS.ErrnoException).code === 'ESRCH' ? 'noProcess' : 'error';
  }
}
