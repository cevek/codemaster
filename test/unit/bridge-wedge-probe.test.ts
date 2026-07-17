// The bridge's wedge probe (t-000051, A3). On a reply-timeout the RemoteOrchestrator fires one
// short-deadline `daemon-info` liveness ping to tell "busy/slow" (front door still answers) from
// "UNRESPONSIVE" (front door wedged → steer to `daemon restart`). Oracle: a fake connection whose
// reply behaviour is programmable + a manual clock — so BOTH the request reply and the probe reply
// can be independently withheld (a real serveDaemon always answers daemon-info, so it cannot
// reproduce the unresponsive-front-door case). No socket, no sleep. The bridge never auto-kills
// (that is B2, deferred) — this only enriches the honest failure message.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRemoteOrchestrator } from '../../src/daemon/remote-orchestrator.ts';
import type { Clock } from '../../src/common/async/clock.ts';
import type { JsonValue } from '../../src/core/json.ts';
import type { TransportConnection } from '../../src/support/transport/seam.ts';

function manualClock(): Clock & { advance(ms: number): void } {
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

const flush = (): Promise<void> => new Promise((r) => setImmediate(r));

interface Env {
  id: number;
  kind: string;
}

/** A connection whose `onSend` decides how to answer each envelope (deliver a reply, or ignore). */
function fakeConn(
  onSend: (env: Env, deliver: (reply: JsonValue) => void) => void,
): TransportConnection {
  let onMsg: (m: JsonValue) => void = () => undefined;
  return {
    send: (env) => onSend(env as unknown as Env, (reply) => queueMicrotask(() => onMsg(reply))),
    onMessage: (h) => void (onMsg = h),
    onClose: () => undefined,
    onError: () => undefined,
    close: () => Promise.resolve(),
  };
}

const infoReply = (id: number): JsonValue =>
  ({
    id,
    kind: 'daemon-info',
    sourceStale: false,
    info: { pid: 7, uptimeMs: 0, engines: 0, engineRoots: [] },
  }) as unknown as JsonValue;

function remoteWith(
  conn: TransportConnection,
  clock: Clock,
): ReturnType<typeof createRemoteOrchestrator> {
  return createRemoteOrchestrator({
    connection: conn,
    clock,
    replyDeadlineMs: 1000,
    probeDeadlineMs: 500,
    version: 'bridge',
  });
}

test('request timeout + front door STILL answers the liveness ping → "busy/slow", no restart steer', async () => {
  const clock = manualClock();
  // Ignores the op request, but answers daemon-info (the front door is alive, just slow).
  const conn = fakeConn((env, deliver) => {
    if (env.kind === 'daemon-info') deliver(infoReply(env.id));
  });
  const remote = remoteWith(conn, clock);
  const p = remote.request('/cwd', undefined, [{ name: 'x', args: {} }]);
  await flush();
  clock.advance(1000); // request reply deadline → probe fires; daemon-info reply lands (microtask)
  const outcome = await p;
  assert.equal(outcome.ok, false);
  assert.ok(
    !outcome.ok && /busy\/slow \(still responsive\)/.test(outcome.message),
    outcome.ok ? '' : outcome.message,
  );
  assert.ok(
    !outcome.ok && !/daemon restart/.test(outcome.message),
    'no restart steer while responsive',
  );
});

test('request timeout + liveness ping ALSO times out → "UNRESPONSIVE" + `daemon restart` steer', async () => {
  const clock = manualClock();
  const conn = fakeConn(() => undefined); // answers nothing — a wedged front door
  const remote = remoteWith(conn, clock);
  const p = remote.request('/cwd', undefined, [{ name: 'x', args: {} }]);
  await flush();
  clock.advance(1000); // request reply deadline → probe sends daemon-info, arms probe deadline
  await flush();
  clock.advance(500); // probe deadline → unresponsive (bounded — no spin)
  const outcome = await p;
  assert.equal(outcome.ok, false);
  assert.ok(!outcome.ok && /UNRESPONSIVE/.test(outcome.message));
  assert.ok(!outcome.ok && /codemaster daemon restart/.test(outcome.message));
});

test('status timeout on a wedged front door → degraded view carries the restart steer', async () => {
  const clock = manualClock();
  const conn = fakeConn(() => undefined);
  const remote = remoteWith(conn, clock);
  const p = remote.status('/cwd');
  await flush();
  clock.advance(1000);
  await flush();
  clock.advance(500);
  const view = await p;
  assert.ok(view.workspaceError !== undefined && /UNRESPONSIVE/.test(view.workspaceError));
  assert.match(view.workspaceError, /codemaster daemon restart/);
});
