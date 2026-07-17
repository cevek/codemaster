// Low-level socket-client plumbing for the daemon management verbs (spec-daemon-cli). Pure
// request/reply + close primitives over one `TransportConnection`, split out of `manage.ts` so its
// verb logic stays under the line cap. Each await is deadline-bounded (§1 never-hang): a wedged
// daemon that accepts but never replies / never closes yields a `timeout` / `false`, never a spin.

import type { Clock } from '../common/async/clock.ts';
import type { JsonValue } from '../core/json.ts';
import type { TransportConnection } from '../support/transport/seam.ts';
import { parseWireReply, type WireReply } from './protocol.ts';

export type ReplyOutcome = { kind: 'reply'; reply: WireReply } | { kind: 'timeout' };

/** Single in-flight request/reply, correlated by id, bounded by a deadline. A corrupt or
 *  unmatched line is ignored (the deadline is the backstop), never thrown into the transport. */
export function awaitReply(
  conn: TransportConnection,
  clock: Clock,
  envelope: JsonValue,
  id: number,
  deadlineMs: number,
): Promise<ReplyOutcome> {
  return new Promise<ReplyOutcome>((resolve) => {
    let settled = false;
    const cancel = clock.schedule(deadlineMs, () => {
      if (settled) return;
      settled = true;
      resolve({ kind: 'timeout' });
    });
    conn.onMessage((raw) => {
      if (settled) return;
      const parsed = parseWireReply(raw);
      if (!parsed.ok || parsed.value.id !== id) return;
      settled = true;
      cancel();
      resolve({ kind: 'reply', reply: parsed.value });
    });
    conn.send(envelope);
  });
}

/** Await the connection closing (the `stop` confirmation), bounded. Resolves `true` on close,
 *  `false` on deadline overrun (a wedged daemon that never closed). */
export function awaitClose(
  conn: TransportConnection,
  clock: Clock,
  deadlineMs: number,
): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    let settled = false;
    const cancel = clock.schedule(deadlineMs, () => {
      if (settled) return;
      settled = true;
      resolve(false);
    });
    conn.onClose(() => {
      if (settled) return;
      settled = true;
      cancel();
      resolve(true);
    });
  });
}

export const daemonInfoEnvelope = (id: number): JsonValue =>
  ({ id, kind: 'daemon-info' }) as unknown as JsonValue;
export const shutdownEnvelope = (id: number): JsonValue =>
  ({ id, kind: 'shutdown' }) as unknown as JsonValue;

/** ms → a compact human duration (`45s`, `3m12s`, `2h05m`). */
export function fmtUptime(ms: number): string {
  const totalS = Math.floor(ms / 1000);
  if (totalS < 60) return `${totalS}s`;
  const m = Math.floor(totalS / 60);
  if (m < 60) return `${m}m${String(totalS % 60).padStart(2, '0')}s`;
  const h = Math.floor(m / 60);
  return `${h}h${String(m % 60).padStart(2, '0')}m`;
}
