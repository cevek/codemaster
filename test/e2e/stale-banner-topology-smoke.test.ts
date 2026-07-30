// The banner's topology is wired at the COMPOSITION ROOT, so it is pinned there — with a real
// `node bin.ts mcp` bridge over a real socket to a real spawned daemon.
//
// Why this test exists: `serving` being a REQUIRED option makes OMISSION a compile error, not
// MISWIRING. Every other test supplies its own literal, so flipping `bin.ts`'s bridge call site to
// `'in-process'` would leave the whole suite green while every real MCP agent is told the daemon
// verb cannot reach its server — the exact defect class the banner change exists to remove. This is
// the one arm no in-process harness can cover: only the real bin decides which topology it is in.
//
// Staleness is induced honestly — the daemon's own `src/**` mtime rollup is moved (touch only, no
// content change) after it has spawned and pinned its baseline, then restored. That is the same
// event a dogfooder's edit produces.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readdirSync, statSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { project } from '../helpers/project.ts';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const BIN = path.join(repoRoot, 'src', 'bin.ts');
/** A leaf of codemaster's OWN source — any `.ts` under `src/` moves the daemon's rollup. */
const OWN_SOURCE = path.join(repoRoot, 'src', 'format', 'render', 'concepts.ts');
/** `createSourceStaleTracker`'s TTL is 1.5 s; past it the next read re-walks. */
const STALE_TTL_MS = 1600;

function cleanEnv(extra: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
  return { ...env, ...extra };
}

async function statusText(client: Client): Promise<string> {
  const res = (await client.callTool({ name: 'status', arguments: {} })) as {
    content: { type: string; text: string }[];
  };
  return res.content.map((c) => c.text).join('');
}

async function waitFor(
  cond: () => boolean,
  budgetMs: number,
  options?: { before: () => Promise<void> },
): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < budgetMs) {
    await options?.before();
    if (cond()) return true;
    await new Promise((r) => setTimeout(r, 200));
  }
  await options?.before();
  return cond();
}

test('a REAL bridge is told the daemon remedy (the composition root wires the topology)', async () => {
  const sockDir = mkdtempSync(path.join(tmpdir(), 'cm-topo-'));
  const env = cleanEnv({ CODEMASTER_SOCK_DIR: sockDir, CODEMASTER_MCP_IDLE_MS: '700' });
  const repo = await project({
    'tsconfig.json': '{"compilerOptions":{"strict":true}}',
    'src/index.ts': 'export const x = 1;\n',
  });
  // Restored in `finally`: mtime only, so the tree's CONTENT is untouched either way and git never
  // sees this. Captured before the daemon spawns so the restore returns it to the pinned baseline.
  const before = statSync(OWN_SOURCE);

  const client = new Client({ name: 'topology-smoke', version: '0' });
  try {
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [BIN, 'mcp'],
        cwd: repo.root,
        env,
        stderr: 'ignore',
      }),
    );
    const fresh = await statusText(client);
    assert.match(fresh, /codemaster v/, 'the bridge answers status through a real daemon');
    assert.doesNotMatch(fresh, /PRE-EDIT codemaster/, 'a just-spawned daemon must not nag');

    // The daemon has pinned its baseline; now its own source moves under it. The verdict is
    // TTL-cached (`createSourceStaleTracker`), so we POLL for the banner within a bounded budget
    // rather than sleeping a guessed interval — a slow machine cannot flake it, and a signal that
    // never fires fails loudly instead of passing on a lucky sleep.
    const now = new Date();
    utimesSync(OWN_SOURCE, now, now);
    let body = '';
    const appeared = await waitFor(() => /!! PRE-EDIT codemaster/.test(body), STALE_TTL_MS * 6, {
      before: async () => {
        body = await statusText(client);
      },
    });
    assert.ok(appeared, `a real stale daemon must say so on the wire; got: ${body}`);
    // THE PIN: the daemon-topology remedy, from the real bin. Flipping `bin.ts`'s bridge call site
    // to `'in-process'` renders the other clause and reddens exactly here.
    assert.match(
      body,
      /`codemaster daemon restart`\+reconnect/,
      'daemon remedy, with the reconnect',
    );
    assert.doesNotMatch(
      body,
      /won't touch this server/,
      'the in-process clause must never reach a daemon-backed reader',
    );
  } finally {
    utimesSync(OWN_SOURCE, before.atime, before.mtime);
    await client.close().catch(() => undefined);
    rmSync(repo.root, { recursive: true, force: true });
  }

  // The bridge is gone → the daemon idle-exits (TTL 700ms) and unlinks its socket: this test leaves
  // no process behind and never touches the developer's own daemon (its own CODEMASTER_SOCK_DIR).
  const gone = await waitFor(() => !existsSync(sockDir) || readdirSync(sockDir).length === 0, 8000);
  assert.ok(gone, 'the spawned daemon cleaned up after itself');
  rmSync(sockDir, { recursive: true, force: true });
});
