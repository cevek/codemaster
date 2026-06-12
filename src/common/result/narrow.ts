// Narrowers for the `Result<T>` discriminated union. Consumers must narrow before
// touching `data` — these make the narrowing read as intent.

import type { FailureResult, OkResult, Result } from '../../core/result.ts';

export function isOk<T>(result: Result<T>): result is OkResult<T> {
  return result.ok;
}

export function isFailure<T>(result: Result<T>): result is FailureResult<T> {
  return !result.ok;
}
