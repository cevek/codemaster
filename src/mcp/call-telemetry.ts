// The telemetry span around ONE tool call (spec usage-telemetry, t-807677): stamp the pre-dispatch
// crash breadcrumb, run the call, write the record, clear the breadcrumb. It lives here rather than
// inline in the request handler so the handler stays about DISPATCH, and so the ordering guarantees
// this span exists to hold are stated in one place:
//
//   - the breadcrumb is stamped BEFORE dispatch — a call that never returns (an in-process OOM
//     kills the serving process) is otherwise invisible to the log (§3.4 by omission);
//   - the record is written BEFORE the breadcrumb is cleared — a death between the two reports the
//     call once, never zero times;
//   - the breadcrumb is cleared in a `finally` spanning the WHOLE body — a leftover breadcrumb for
//     a call that WAS answered becomes an invented crash at the next start (the same lie inverted).
//
// Every telemetry call is wrapped: `usage` is an INJECTED seam, so the request path must never
// depend on an implementation's own discipline (§3.6).

import type { Clock } from '../common/async/clock.ts';
import type { JsonValue } from '../core/json.ts';
import type { InflightHandle, UsageLogger } from '../support/usage-log/entry.ts';
import { inflightOps } from './inflight-ops.ts';
import type { LastSuspension } from '../support/suspension/last-suspension.ts';
import { suspendedWithin } from '../common/suspension/overlap.ts';

/** Below this a call is not checked for a sleep: the probe spawns `sysctl`, and a short call's
 *  duration is not what anyone misreads. */
export const SUSPENSION_PROBE_MIN_MS = 10_000;

const NOOP_INFLIGHT: InflightHandle = { clear: () => undefined };

export interface TelemetrySpanOptions<T> {
  usage: UsageLogger;
  clock: Clock;
  tool: string;
  args: unknown;
  cwd: string;
  /** The machine's last sleep/wake cycle — fills `UsageLogEntry.suspendedMs`. */
  lastSuspension?: LastSuspension;
  /** Run the call; returns the response plus its telemetry classification. */
  run: () => Promise<{ ok: boolean; ops: string[]; response: string; isError: boolean; value: T }>;
}

export async function withCallTelemetry<T>(options: TelemetrySpanOptions<T>): Promise<T> {
  const { usage, clock, tool, args, cwd } = options;
  const startMs = clock.now();
  const rawArgs = (args ?? null) as JsonValue;
  let inflight: InflightHandle = NOOP_INFLIGHT;
  try {
    inflight = usage.begin({ ts: startMs, tool, ops: inflightOps(tool, args), cwd, args: rawArgs });
  } catch {
    /* telemetry must never crash the daemon */
  }
  try {
    const outcome = await options.run();
    const endMs = clock.now();
    const suspendedMs = await probeSuspended(options.lastSuspension, startMs, endMs);
    try {
      usage.record({
        ts: startMs,
        durationMs: endMs - startMs,
        tool,
        ops: outcome.ops,
        ok: outcome.ok,
        cwd,
        args: rawArgs,
        response: outcome.response,
        isError: outcome.isError,
        ...(suspendedMs > 0 ? { suspendedMs } : {}),
      });
    } catch {
      /* telemetry must never crash the daemon */
    }
    return outcome.value;
  } finally {
    try {
      inflight.clear();
    } catch {
      /* nothing more we can do; a stale breadcrumb is reconciled at the next start */
    }
  }
}

async function probeSuspended(
  probe: LastSuspension | undefined,
  startMs: number,
  endMs: number,
): Promise<number> {
  if (probe === undefined || endMs - startMs < SUSPENSION_PROBE_MIN_MS) return 0;
  try {
    const s = await probe();
    return s === undefined ? 0 : suspendedWithin(startMs, endMs, s);
  } catch {
    return 0;
  }
}
