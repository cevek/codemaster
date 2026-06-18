// Bind-or-connect convergence (spec-daemon-singleton §2/§19/§7). Drives connectOrSpawnDaemon over a
// real socket, with an in-process serveDaemon standing in for the spawned daemon (the real spawned
// child is covered by the bridge smoke). Oracles: an existing daemon is reused (no spawn); no daemon
// → spawn → connect; a STALE socket file (SIGKILLed daemon) is unlinked and a fresh daemon rebinds.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { connectOrSpawnDaemon } from '../../src/daemon/connect-or-spawn.ts';
import { serveDaemon, type DaemonHandle } from '../../src/daemon/daemon-server.ts';
import type { OrchestratorApi } from '../../src/daemon/orchestrator-api.ts';
import { createUnixSocketTransport } from '../../src/support/transport/unix-socket.ts';
import { socketPath } from '../../src/support/transport/socket-path.ts';
import { systemClock } from '../../src/common/async/clock.ts';
import type { Transport } from '../../src/support/transport/seam.ts';

process.setMaxListeners(50);

function stubOrch(): OrchestratorApi {
  return {
    request: async () => ({ ok: true, results: [] }),
    status: async () => ({
      daemonVersion: 'd',
      pid: 1,
      isolation: 'in-process',
      engines: 0,
      engineRoots: [],
      workspace: undefined,
      workspaceError: undefined,
      debugTopics: [],
      sourceStale: false,
    }),
    sourceStale: () => false,
    dispose: async () => undefined,
  };
}

async function startDaemon(transport: Transport): Promise<DaemonHandle> {
  return serveDaemon({
    orchestrator: stubOrch(),
    transport,
    clock: systemClock,
    idleMs: 600_000,
    exit: () => undefined,
  });
}

function setup(): { dir: string; sock: string; transport: Transport; cleanup: () => void } {
  const dir = mkdtempSync(path.join(tmpdir(), 'cm-cvg-'));
  const sock = socketPath('test', dir);
  return {
    dir,
    sock,
    transport: createUnixSocketTransport(sock),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

test('convergence: an existing daemon is reused — no spawn', async () => {
  const s = setup();
  const daemon = await startDaemon(s.transport);
  let spawned = false;
  try {
    const conn = await connectOrSpawnDaemon({
      transport: s.transport,
      socketPath: s.sock,
      clock: systemClock,
      spawnDaemon: () => (spawned = true),
    });
    assert.ok(conn, 'connected');
    assert.equal(spawned, false, 'did not spawn — reused the live daemon');
    await conn?.close();
  } finally {
    await daemon.shutdown();
    s.cleanup();
  }
});

test('convergence: no daemon → spawn → connect', async () => {
  const s = setup();
  let daemon: DaemonHandle | undefined;
  try {
    const conn = await connectOrSpawnDaemon({
      transport: s.transport,
      socketPath: s.sock,
      clock: systemClock,
      spawnDaemon: () =>
        void (async () => {
          daemon = await startDaemon(s.transport);
        })(),
    });
    assert.ok(conn, 'connected to the spawned daemon');
    await conn?.close();
  } finally {
    if (daemon !== undefined) await daemon.shutdown();
    s.cleanup();
  }
});

test('convergence: a STALE socket file (SIGKILLed daemon) is unlinked, then a fresh daemon rebinds', async () => {
  const s = setup();
  // Simulate a daemon SIGKILLed mid-life: its socket file is left behind on disk (node unlinks on
  // a GRACEFUL close, so a leftover file is exactly the SIGKILL case). A connect to it fails, and
  // a fresh daemon can't bind until the leftover is unlinked — which connectOrSpawn does first.
  writeFileSync(s.sock, '');
  assert.ok(existsSync(s.sock), 'stale socket file present');

  let daemon: DaemonHandle | undefined;
  try {
    const conn = await connectOrSpawnDaemon({
      transport: s.transport,
      socketPath: s.sock,
      clock: systemClock,
      spawnDaemon: () =>
        void (async () => {
          // The stale file must be unlinked before this can bind; connectOrSpawn does that first.
          daemon = await startDaemon(s.transport);
        })(),
    });
    assert.ok(conn, 'rebound after clearing the stale socket — no hang');
    await conn?.close();
  } finally {
    if (daemon !== undefined) await daemon.shutdown();
    s.cleanup();
  }
});
