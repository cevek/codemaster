// The banner's topology is wired at the COMPOSITION ROOT, so it is pinned there — with a real
// `node bin.ts mcp` bridge over a real socket to a real spawned daemon.
//
// Why this test exists: `serving` being a REQUIRED option makes OMISSION a compile error, not
// MISWIRING. Every other test supplies its own literal, so flipping `bin.ts`'s bridge call site to
// `'in-process'` would leave the whole suite green while every real MCP agent is told the daemon
// verb cannot reach its server — the exact defect class the banner change exists to remove. This is
// the one arm no in-process harness can cover: only the real bin decides which topology it is in.
//
// Staleness is induced against a THROWAWAY COPY of `src/`, never the working tree. The daemon
// fingerprints the source tree it was launched from (`import.meta.url`), so launching the bridge
// from the copy makes that copy the thing whose mtimes we may move. Touching the real `src/` would
// be unrecoverable in the way that matters: the rollup carries sub-millisecond `mtimeMs` that
// `utimesSync` cannot round-trip, so a "restore" leaves a permanent drift — every later answer from
// any daemon serving this checkout would carry a stale banner over a tree nobody edited (the exact
// false positive §3.6 forbids), and it would race `defaultSourceFingerprint`'s stability test
// running in parallel.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  symlinkSync,
  utimesSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { project } from '../helpers/project.ts';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
/** `createSourceStaleTracker`'s TTL is 1.5 s; past it the next read re-walks. */
const STALE_TTL_MS = 1600;

/** A runnable copy of codemaster: `src/` duplicated (so its mtimes are ours to move), `package.json`
 *  copied (module type + name), `node_modules` symlinked (deps resolve, nothing is duplicated). The
 *  bridge AND the daemon it spawns both run from here — `spawnDaemon` re-invokes the same
 *  `import.meta.url` bin — so the staleness signal we drive is entirely this copy's. */
function copyOfCodemaster(): { bin: string; ownSource: string; cleanup: () => void } {
  const dir = mkdtempSync(path.join(tmpdir(), 'cm-topo-src-'));
  cpSync(path.join(repoRoot, 'src'), path.join(dir, 'src'), { recursive: true });
  cpSync(path.join(repoRoot, 'package.json'), path.join(dir, 'package.json'));
  symlinkSync(path.join(repoRoot, 'node_modules'), path.join(dir, 'node_modules'), 'dir');
  return {
    bin: path.join(dir, 'src', 'bin.ts'),
    // Any `.ts` under the copy's `src/` moves its rollup; a leaf with no runtime role keeps the
    // touch from looking like it is trying to change behavior.
    ownSource: path.join(dir, 'src', 'format', 'render', 'concepts.ts'),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

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
  const copy = copyOfCodemaster();
  const repo = await project({
    'tsconfig.json': '{"compilerOptions":{"strict":true}}',
    'src/index.ts': 'export const x = 1;\n',
  });

  const client = new Client({ name: 'topology-smoke', version: '0' });
  try {
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [copy.bin, 'mcp'],
        cwd: repo.root,
        env,
        stderr: 'ignore',
      }),
    );
    const fresh = await statusText(client);
    assert.match(fresh, /codemaster v/, 'the bridge answered a status call');
    assert.doesNotMatch(fresh, /PRE-EDIT codemaster/, 'a just-spawned daemon must not nag');
    // A DAEMON is what we are pinning: if the spawn had failed, `bin.ts` falls back to in-process
    // serving, which renders the other clause — and the remedy assertion below would read as a
    // wiring bug when it was an environment failure. The bound socket separates the two causes.
    assert.ok(readdirSync(sockDir).length > 0, 'a real daemon bound the socket (not the fallback)');

    // The daemon has pinned its baseline; now the source tree it was launched from moves under it.
    // The verdict is TTL-cached (`createSourceStaleTracker`), so we POLL for the banner within a
    // bounded budget rather than sleeping a guessed interval — a slow machine cannot flake it, and
    // a signal that never fires fails loudly instead of passing on a lucky sleep.
    const now = new Date();
    utimesSync(copy.ownSource, now, now);
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
    await client.close().catch(() => undefined);
    rmSync(repo.root, { recursive: true, force: true });
    // The bridge is gone → the daemon idle-exits (TTL 700ms) and unlinks its socket. Waited for in
    // `finally` so a failed assertion still leaves no process, no socket dir and no source copy
    // behind; the developer's own daemon is untouched either way (own sock dir, own source tree).
    const gone = await waitFor(
      () => !existsSync(sockDir) || readdirSync(sockDir).length === 0,
      8000,
    );
    rmSync(sockDir, { recursive: true, force: true });
    copy.cleanup();
    assert.ok(gone, 'the spawned daemon cleaned up after itself');
  }
});
