// Shared deterministic fakes for the daemon management-verb tests (spec-daemon-cli / t-000051): a
// manual clock, a programmable in-memory connection/transport, and the daemon-info/error reply
// builders. No real socket, no sleep — the verbs are pure socket clients, so a fake connection +
// manual clock exercises every path (including the no-hang ones a real socket can't reach).

import type { DaemonManageDeps } from '../../src/daemon/manage.ts';
import type { Clock } from '../../src/common/async/clock.ts';
import type { JsonValue } from '../../src/core/json.ts';
import type { Transport, TransportConnection } from '../../src/support/transport/seam.ts';

export function manualClock(): Clock & { advance(ms: number): void } {
  let now = 1_000_000;
  const timers: { at: number; fn: () => void }[] = [];
  return {
    now: () => now,
    schedule(ms, fn) {
      const t = { at: now + ms, fn };
      timers.push(t);
      return () => {
        const i = timers.indexOf(t);
        if (i !== -1) timers.splice(i, 1);
      };
    },
    advance(ms) {
      now += ms;
      for (const t of [...timers].sort((a, b) => a.at - b.at)) {
        if (t.at <= now) {
          const i = timers.indexOf(t);
          if (i !== -1) timers.splice(i, 1);
          t.fn();
        }
      }
    },
  };
}

export const flush = (): Promise<void> => new Promise((r) => setImmediate(r));

export interface Envelope {
  id: number;
  kind: string;
}

/** A programmable connection: `onSend` decides how to react to each outbound envelope (deliver a
 *  reply, close the link, or ignore it — a wedged daemon). */
export function fakeConnection(
  onSend: (env: Envelope, deliver: (reply: JsonValue) => void, close: () => void) => void,
): TransportConnection {
  let onMsg: (m: JsonValue) => void = () => undefined;
  let onCloseCb: () => void = () => undefined;
  return {
    send(envelope) {
      onSend(
        envelope as unknown as Envelope,
        (reply) => queueMicrotask(() => onMsg(reply)),
        () => queueMicrotask(() => onCloseCb()),
      );
    },
    onMessage: (h) => void (onMsg = h),
    onClose: (h) => void (onCloseCb = h),
    onError: () => undefined,
    close: () => Promise.resolve(),
  };
}

/** A transport that yields `conn` on connect, or rejects ENOENT when `conn` is undefined (no daemon). */
export function transportFor(conn: TransportConnection | undefined): Transport {
  return {
    listen: () => Promise.reject(new Error('listen unused in manage tests')),
    connect: () =>
      conn === undefined
        ? Promise.reject(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }))
        : Promise.resolve(conn),
  };
}

export function deps(over: Partial<DaemonManageDeps>): DaemonManageDeps {
  return {
    transport: transportFor(undefined),
    socketPath: '/tmp/cm-test.sock',
    clock: manualClock(),
    spawnDaemon: () => undefined,
    replyDeadlineMs: 1000,
    stopTimeoutMs: 2000,
    ...over,
  };
}

export const infoReply = (
  id: number,
  info: Record<string, unknown>,
  sourceStale = false,
): JsonValue => ({ id, kind: 'daemon-info', sourceStale, info }) as unknown as JsonValue;
export const errReply = (id: number, message: string): JsonValue =>
  ({ id, kind: 'error', message }) as unknown as JsonValue;
export const INFO = { pid: 42, uptimeMs: 65_000, engines: 2, engineRoots: ['/a', '/b'] };
