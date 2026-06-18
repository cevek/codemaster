// The bridge's RemoteOrchestrator (spec-daemon-singleton §2). Drives it against a REAL daemon
// socket (an in-process serveDaemon with a stub orchestrator), with an injected clock for the
// reply deadline. Oracles: a request round-trips and returns the daemon's outcome; sourceStale
// rides the daemon's reply; a non-replying daemon yields an honest timeout (never an unbounded
// wait, §1); a dropped connection fails in-flight requests at once.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { serveDaemon } from '../../src/daemon/daemon-server.ts';
import { createRemoteOrchestrator } from '../../src/daemon/remote-orchestrator.ts';
import type { OrchestratorApi } from '../../src/daemon/orchestrator-api.ts';
import { createUnixSocketTransport } from '../../src/support/transport/unix-socket.ts';
import { socketPath } from '../../src/support/transport/socket-path.ts';
import { systemClock, type Clock } from '../../src/common/async/clock.ts';

process.setMaxListeners(50);

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

function stubOrch(over: Partial<OrchestratorApi> = {}): OrchestratorApi {
  return {
    request: async () => ({ ok: true, results: [] }),
    status: async () => ({
      daemonVersion: 'daemon',
      pid: 99,
      isolation: 'in-process',
      engines: 1,
      engineRoots: ['/repo'],
      workspace: undefined,
      workspaceError: undefined,
      debugTopics: [],
      sourceStale: false,
    }),
    sourceStale: () => false,
    dispose: async () => undefined,
    ...over,
  };
}

async function withDaemonAndRemote(
  orch: OrchestratorApi,
  run: (remote: OrchestratorApi, clock: Clock & { advance(ms: number): void }) => Promise<void>,
): Promise<void> {
  const dir = mkdtempSync(path.join(tmpdir(), 'cm-rem-'));
  const transport = createUnixSocketTransport(socketPath('test', dir));
  const daemon = await serveDaemon({
    orchestrator: orch,
    transport,
    clock: systemClock,
    idleMs: 600_000, // far out — not under test here
    exit: () => undefined,
  });
  const clock = manualClock();
  const connection = await transport.connect();
  const remote = createRemoteOrchestrator({
    connection,
    clock,
    replyDeadlineMs: 1000,
    version: 'bridge',
  });
  try {
    await run(remote, clock);
  } finally {
    await remote.dispose();
    await daemon.shutdown();
    rmSync(dir, { recursive: true, force: true });
  }
}

test('remote: request round-trips and returns the daemon outcome', async () => {
  await withDaemonAndRemote(
    stubOrch({
      request: async () => ({
        ok: true,
        results: [{ name: 'find_definition', error: { kind: 'op_threw', message: 'd' } }],
      }),
    }),
    async (remote) => {
      const outcome = await remote.request('/cwd', undefined, [
        { name: 'find_definition', args: {} },
      ]);
      assert.equal(outcome.ok, true);
      assert.ok(outcome.ok && outcome.results.length === 1);
    },
  );
});

test('remote: sourceStale rides the daemon reply (banner reflects daemon code age)', async () => {
  await withDaemonAndRemote(stubOrch({ sourceStale: () => true }), async (remote) => {
    assert.equal(remote.sourceStale(), false, 'no reply seen yet → default false');
    await remote.request('/cwd', undefined, [{ name: 'x', args: {} }]);
    assert.equal(remote.sourceStale(), true, 'cached from the daemon reply envelope');
  });
});

test('remote: a non-replying daemon yields an honest timeout (never an unbounded wait)', async () => {
  await withDaemonAndRemote(
    stubOrch({ request: () => new Promise(() => undefined) }), // never resolves
    async (remote, clock) => {
      const p = remote.request('/cwd', undefined, [{ name: 'x', args: {} }]);
      await flush();
      clock.advance(1001); // past the reply deadline
      const outcome = await p;
      assert.equal(outcome.ok, false);
      assert.ok(!outcome.ok && /did not reply/.test(outcome.message));
    },
  );
});

test('remote: status returns the daemon view', async () => {
  await withDaemonAndRemote(stubOrch(), async (remote) => {
    const view = await remote.status('/cwd');
    assert.equal(view.daemonVersion, 'daemon');
    assert.equal(view.engines, 1);
  });
});

test('remote: a dropped connection fails an in-flight request honestly', async () => {
  await withDaemonAndRemote(
    stubOrch({ request: () => new Promise(() => undefined) }),
    async (remote) => {
      const p = remote.request('/cwd', undefined, [{ name: 'x', args: {} }]);
      await flush();
      await remote.dispose(); // close the connection mid-flight
      const outcome = await p;
      assert.equal(outcome.ok, false);
      assert.ok(!outcome.ok && /connection closed/.test(outcome.message));
    },
  );
});
