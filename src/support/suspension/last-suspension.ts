// The kernel's record of the machine's last sleep/wake cycle (darwin `kern.sleeptime` /
// `kern.waketime`). Elsewhere `undefined` — on Linux libuv's monotonic clock excludes suspend, so the
// timers that need this explanation do not overrun there. `undefined` always means "unknown", never
// "did not sleep".

import { execFile } from 'node:child_process';
import process from 'node:process';
import type { Suspension } from '../../common/suspension/overlap.ts';

export type LastSuspension = () => Promise<Suspension | undefined>;

const SYSCTL_TIMEOUT_MS = 2_000;

/** `sysctl -n kern.sleeptime kern.waketime` prints one `{ sec = N, usec = M } <date>` line each. */
export function parseSleepWake(stdout: string): Suspension | undefined {
  const stamps = [...stdout.matchAll(/\{\s*sec\s*=\s*(\d+),\s*usec\s*=\s*(\d+)\s*\}/g)].map(
    (m) => Number(m[1]) * 1000 + Math.floor(Number(m[2]) / 1000),
  );
  const [sleptAtMs, wokeAtMs] = stamps;
  if (stamps.length !== 2 || sleptAtMs === undefined || wokeAtMs === undefined) return undefined;
  // A machine that never slept since boot reports 0; a wake before its sleep is a cycle in progress
  // or a reading we cannot interpret — neither describes a completed suspension.
  if (sleptAtMs <= 0 || wokeAtMs <= sleptAtMs) return undefined;
  return { sleptAtMs, wokeAtMs };
}

export const readLastSuspension: LastSuspension = () => {
  if (process.platform !== 'darwin') return Promise.resolve(undefined);
  return new Promise((resolve) => {
    try {
      execFile(
        'sysctl',
        ['-n', 'kern.sleeptime', 'kern.waketime'],
        { encoding: 'utf8', timeout: SYSCTL_TIMEOUT_MS },
        (error, stdout) => resolve(error === null ? parseSleepWake(stdout) : undefined),
      );
    } catch {
      resolve(undefined);
    }
  });
};
