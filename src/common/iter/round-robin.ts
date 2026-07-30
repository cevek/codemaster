// Interleave N queues so ONE shared budget is spread across them instead of being drained by
// whichever queue happens to be first. The domain reason it exists (and why it is not a `flat()`):
// a cross-program fan spends a single cap over per-program queues, and a large primary that
// enumerated 3000 candidates must not exhaust the cap before a sibling's first item is reached —
// a starved-to-zero sibling is exactly the shape that makes a single-program `0` look like a verdict
// (§3.4). Queue order still decides WITHIN a round (the type authority leads).

/** Yield `q0[0], q1[0], …, q0[1], q1[1], …`, skipping queues that have run out. */
export function* roundRobin<T>(queues: readonly (readonly T[])[]): Generator<T> {
  const longest = queues.reduce((n, q) => Math.max(n, q.length), 0);
  for (let i = 0; i < longest; i++) {
    for (const queue of queues) {
      const item = queue[i];
      if (item !== undefined) yield item;
    }
  }
}
