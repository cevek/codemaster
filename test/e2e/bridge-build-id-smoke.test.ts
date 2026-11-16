// The build id a real `node bin.ts mcp` bridge reports is the DAEMON's (§13): relayed from the
// daemon's replies into `serverInfo.version` and the first answer's stamp — never the bridge's own.
// Arm 1 spawns a real daemon on an isolated socket. Arms 2/3 put a daemon with a KNOWN, different
// build (and one that sends none, as a daemon predating build ids) on the socket the real bridge
// connects to, so what the bridge reports can only have come from the daemon.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { serveDaemon } from '../../src/daemon/daemon-server.ts';
import type { ServingOrchestrator } from '../../src/daemon/orchestrator-api.ts';
import { createUnixSocketTransport } from '../../src/support/transport/unix-socket.ts';
import { socketPath } from '../../src/support/transport/socket-path.ts';
import { packageVersion } from '../../src/support/build-id/package-version.ts';
import { systemClock } from '../../src/common/async/clock.ts';

const bin = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'src', 'bin.ts');

function env(sockDir: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) out[k] = v;
  return {
    ...out,
    CODEMASTER_SOCK_DIR: sockDir,
    CODEMASTER_USAGE_LOG: '0',
    CODEMASTER_MCP_IDLE_MS: '700',
  };
}

async function bridge(sockDir: string): Promise<{ client: Client; first: string }> {
  const client = new Client({ name: 'build-id-smoke', version: '0' });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [bin, 'mcp'],
      env: env(sockDir),
      stderr: 'ignore',
    }),
  );
  const r = (await client.callTool({ name: 'feedback', arguments: {} })) as {
    content: { type: string; text: string }[];
  };
  return { client, first: r.content.map((c) => c.text).join('') };
}

function stub(build: string | undefined): ServingOrchestrator {
  return {
    request: async (_cwd, _root, reqs) => ({
      ok: true,
      results: reqs.map((r) => ({ name: r.name, result: { ok: true, data: { filed: true } } })),
    }),
    status: async () => ({}) as never,
    sourceStale: () => false,
    buildId: () => build,
    daemonInfo: () => ({ pid: 1, uptimeMs: 0, engines: 0, engineRoots: [] }),
    dispose: async () => undefined,
  };
}

async function withFakeDaemon(
  build: string | undefined,
  run: (sockDir: string) => Promise<void>,
): Promise<void> {
  const sockDir = mkdtempSync(path.join(tmpdir(), 'cm-bid-'));
  const daemon = await serveDaemon({
    orchestrator: stub(build),
    transport: createUnixSocketTransport(socketPath(packageVersion(), sockDir)),
    clock: systemClock,
    idleMs: 600_000,
    exit: () => undefined,
  });
  try {
    await run(sockDir);
  } finally {
    await daemon.shutdown();
    rmSync(sockDir, { recursive: true, force: true });
  }
}

test('a real bridge over a real spawned daemon: serverInfo and the first stamp name one build', async () => {
  const sockDir = mkdtempSync(path.join(tmpdir(), 'cm-bid-real-'));
  const { client, first } = await bridge(sockDir);
  try {
    assert.ok(readdirSync(sockDir).length > 0, 'a real daemon bound the socket (not the fallback)');
    const info = client.getServerVersion()?.version ?? '';
    const build = /^codemaster v(\S+ @\S+)\n/.exec(first)?.[1];
    assert.match(build ?? '', /^\d+\.\d+\.\d+ @(?:[0-9a-f]{9}(?:\+dirty)?|unknown)$/, first);
    assert.ok(info === build || info === `${packageVersion()} @unknown`, `${info} vs ${build}`);
  } finally {
    await client.close();
    rmSync(sockDir, { recursive: true, force: true });
  }
});

test("the bridge reports the DAEMON's build, not its own", async () => {
  await withFakeDaemon('9.9.9 @feedc0de1', async (sockDir) => {
    const { client, first } = await bridge(sockDir);
    try {
      assert.equal(client.getServerVersion()?.version, '9.9.9 @feedc0de1');
      assert.ok(first.startsWith('codemaster v9.9.9 @feedc0de1\n'), first);
    } finally {
      await client.close();
    }
  });
});

test('a daemon that sends no build reads as @unknown (daemon predates build ids)', async () => {
  await withFakeDaemon(undefined, async (sockDir) => {
    const { client, first } = await bridge(sockDir);
    try {
      const expected = `${packageVersion()} @unknown (daemon predates build ids)`;
      assert.equal(client.getServerVersion()?.version, expected);
      assert.ok(first.startsWith(`codemaster v${expected}\n`), first);
    } finally {
      await client.close();
    }
  });
});
