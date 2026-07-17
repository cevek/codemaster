// The mutating-op compute/gate error-translation chokepoint (§1 never-hang). A refactoring's
// expensive phase — the LS reference search + the §2.8 typecheck gate — runs BEFORE the atomic
// write (§7 write-last), under the op's cooperative wall-clock `Deadline`. On overrun the ts
// plugin raises a `DeadlineExceededError`; this turns it into an honest `ToolFailure{tool:'timeout'}`
// with NO data (never a `partial` — a cancelled monolithic call produced nothing, and an empty
// result dressed as partial reads as "0 sites", §3.4). Anything else is a real tool fault →
// `failFromThrown` (never swallow a genuine error as a timeout).

import type { FailureResult } from '../core/result.ts';
import { DeadlineExceededError } from '../common/async/deadline.ts';
import { fail, failFromThrown } from '../common/result/construct.ts';

export function failTimeoutOr<T = never>(
  label: string,
  category: string,
  thrown: unknown,
): FailureResult<T> {
  if (thrown instanceof DeadlineExceededError) {
    return fail({
      tool: 'timeout',
      message: `${label} exceeded its wall-clock budget during compute — no files were written (${thrown.message}); narrow the refactor (a smaller target / fewer sites) or fall back`,
    });
  }
  return failFromThrown(category, thrown);
}

/** The bare `timeout` failure for a loop-boundary / pre-write deadline check (no thrown value —
 *  the op polled `deadline.expired()` itself). Same honesty: no data, nothing written. */
export function failTimeout<T = never>(label: string): FailureResult<T> {
  return fail({
    tool: 'timeout',
    message: `${label} exceeded its wall-clock budget before writing — nothing was written; narrow the refactor or fall back`,
  });
}
