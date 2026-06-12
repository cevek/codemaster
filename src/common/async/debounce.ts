// Debounce built on the `Clock` seam — used by the watcher pipeline (editor atomic
// saves spray events; §19 "editor temp churn"). Trailing-edge: the call runs `ms`
// after the *last* trigger. `flush()` runs a pending call immediately (tests and
// shutdown paths); `cancel()` drops it.

import type { CancelTimer, Clock } from './clock.ts';

export interface Debounced<A extends readonly unknown[]> {
  trigger(...args: A): void;
  /** Run the pending call now, if any. */
  flush(): void;
  /** Drop the pending call, if any. */
  cancel(): void;
}

export function debounce<A extends readonly unknown[]>(
  clock: Clock,
  ms: number,
  fn: (...args: A) => void,
): Debounced<A> {
  let pending: { args: A; cancel: CancelTimer } | undefined;

  const fire = (): void => {
    if (pending === undefined) return;
    const { args } = pending;
    pending.cancel();
    pending = undefined;
    fn(...args);
  };

  return {
    trigger(...args: A) {
      pending?.cancel();
      pending = { args, cancel: clock.schedule(ms, fire) };
    },
    flush: fire,
    cancel() {
      pending?.cancel();
      pending = undefined;
    },
  };
}
