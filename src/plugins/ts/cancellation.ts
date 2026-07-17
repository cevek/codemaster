// The deadline-driven cancellation the multi-program host shares across every program's LS
// (§1 never-hang). TS's `findReferences` / navto poll `getCancellationToken().isCancellationRequested()`
// hundreds of times and throw `OperationCanceledException` when it returns true — so a single big
// synchronous LS search can be bounded by a wall-clock `Deadline` instead of spinning. This owns
// the ONE mutable predicate (pointed at the active read's deadline for its duration, `() => false`
// otherwise) and the ts→domain error translation, so the host and the op layer stay clean.

import ts from 'typescript';
import { type Deadline, DeadlineExceededError } from '../../common/async/deadline.ts';

export interface Cancellation {
  /** The predicate every program's `getCancellationToken` reads — `true` once the active read's
   *  deadline is spent. Default `false` (no bounded read in flight). */
  cancel(): boolean;
  /** Run `fn` (a synchronous LS read) under `deadline`: the shared predicate points at it for the
   *  duration, so the LS cancels on overrun. Translates TS's `OperationCanceledException` into a
   *  `DeadlineExceededError` the op turns into a `ToolFailure{tool:'timeout'}`. Not re-entrant (the
   *  engine serializes requests, §8); resets the predicate in a `finally` so a read never leaks its
   *  budget into the next. `NO_DEADLINE` → never trips (byte-identical to no wrap). */
  withDeadline<T>(deadline: Deadline, fn: () => T): T;
}

export function createCancellation(): Cancellation {
  let pred: () => boolean = () => false;
  return {
    cancel: () => pred(),
    withDeadline(deadline, fn) {
      pred = () => deadline.expired();
      try {
        return fn();
      } catch (thrown) {
        // The LS threw because the predicate said the budget was spent — translate the ts-specific
        // cancellation into the domain error so the op layer never imports `typescript`.
        if (thrown instanceof ts.OperationCanceledException) {
          throw new DeadlineExceededError(
            'the TS language service search exceeded its wall-clock budget',
          );
        }
        throw thrown;
      } finally {
        pred = () => false; // never leak this read's budget into the next
      }
    },
  };
}
