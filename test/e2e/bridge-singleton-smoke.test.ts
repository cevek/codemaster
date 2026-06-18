// The headline real-process smoke (spec-daemon-singleton §2/§7): two REAL `node bin.ts mcp` bridges
// spawned via stdio MCP converge on ONE shared daemon (proven by an identical daemon pid in their
// status), one bridge's client disconnect exits that bridge while the daemon and the other bridge
// survive, and the daemon idle-self-exits + unlinks its socket once the last bridge is gone. This is
// the live oracle for the amortization + orphan-freedom the whole spec exists for.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { project } from '../helpers/project.ts';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const BIN = path.join(repoRoot, 'src', 'bin.ts');

function cleanEnv(extra: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
  return { ...env, ...extra };
}

async function spawnBridge(cwd: string, env: Record<string, string>): Promise<Client> {
  const client = new Client({ name: 'smoke', version: '0' });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [BIN, 'mcp'],
    cwd,
    env,
    stderr: 'ignore',
  });
  await client.connect(transport);
  return client;
}

async function statusText(client: Client): Promise<string> {
  const res = (await client.callTool({ name: 'status', arguments: {} })) as {
    content: { type: string; text: string }[];
  };
  return res.content.map((c) => c.text).join('');
}

const pidOf = (status: string): string => /pid=(\d+)/.exec(status)?.[1] ?? '?';

test('two real bridges share one daemon; a disconnect leaves the daemon + peer alive; idle-exit cleans up', async () => {
  const sockDir = mkdtempSync(path.join(tmpdir(), 'cm-1d-'));
  // CODEMASTER_MCP_IDLE_MS makes the spawned daemon idle-exit fast once both bridges are gone, so
  // the test leaves no lingering process/socket.
  const env = cleanEnv({ CODEMASTER_SOCK_DIR: sockDir, CODEMASTER_MCP_IDLE_MS: '700' });
  const repo = await project({
    'tsconfig.json': '{"compilerOptions":{"strict":true}}',
    'src/index.ts': 'export const x = 1;\n',
  });

  const bridgeA = await spawnBridge(repo.root, env);
  try {
    const a = await statusText(bridgeA);
    assert.match(a, /codemaster v/, 'bridge A answers status through the daemon');

    const bridgeB = await spawnBridge(repo.root, env);
    const b = await statusText(bridgeB);
    // Same daemon pid from two independent bridges ⇒ exactly one shared daemon (amortization).
    assert.equal(pidOf(a), pidOf(b), 'both bridges report the SAME daemon pid — one singleton');

    // Bridge A's client disconnects (closes stdin) → A exits; the daemon + B survive.
    await bridgeA.close();
    const b2 = await statusText(bridgeB);
    assert.equal(pidOf(b2), pidOf(b), 'B still served by the same daemon after A disconnects');

    await bridgeB.close();
  } finally {
    await bridgeA.close().catch(() => undefined);
    rmSync(repo.root, { recursive: true, force: true });
  }

  // With both bridges gone, the daemon idle-exits (TTL 700ms) and unlinks its socket — bounded poll.
  const sockGone = await waitFor(() => readdirEmpty(sockDir), 8000);
  assert.ok(sockGone, 'daemon idle-exited and unlinked its socket after the last bridge left');
  rmSync(sockDir, { recursive: true, force: true });
});

function readdirEmpty(dir: string): boolean {
  // The daemon's socket is the only file we put here; gone ⇒ daemon cleaned up.
  return !existsSync(dir) || readdirSync(dir).length === 0;
}

async function waitFor(cond: () => boolean, budgetMs: number): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < budgetMs) {
    if (cond()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return cond();
}
