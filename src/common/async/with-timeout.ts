// Bound a promise by the `Clock` seam. The outcome is explicit — `timedOut` is a
// first-class answer, not a synthetic rejection that could be mistaken for the
// operation's own failure (honest uncertainty, applied to time).

import type { Clock } from './clock.ts';
import { deferred } from './deferred.ts';

export type TimeoutOutcome<T> = { timedOut: false; value: T } | { timedOut: true };

export async function withTimeout<T>(
  clock: Clock,
  ms: number,
  work: Promise<T>,
): Promise<TimeoutOutcome<T>> {
  const timeout = deferred<TimeoutOutcome<T>>();
  const cancel = clock.schedule(ms, () => timeout.resolve({ timedOut: true }));
  try {
    return await Promise.race([
      work.then((value): TimeoutOutcome<T> => ({ timedOut: false, value })),
      timeout.promise,
    ]);
  } finally {
    cancel();
  }
}
