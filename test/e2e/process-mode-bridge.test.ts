// The live process-mode path end-to-end (t-605174, §2/§16). The keystone t-000052 proved
// process≡in-process byte-parity by driving `createProcessHost`/`Orchestrator` DIRECTLY; this test
// closes the coverage gap one level up — the FULL wire path a real client uses: a real `node bin.ts
// mcp` stdio↔socket BRIDGE → daemon → `serve-engine` child. A workspace configured
// `daemon.isolation:'process'` (via a temp-workspace `codemaster.config.ts`, NEVER the repo root —
// that would flip this repo's default + disrupt the live dogfood daemon) forks the child; the op
// results are asserted byte-equal to the in-process path (the §16 parity cousin).
//
// LOAD-BEARING discriminator (guards against a silent false-green): a positive assertion that the
// process host was actually built. `status.isolation` is dynamic (reads the resolved host's real
// transport, t-000052 Phase A), so the process run asserts `isolation=process` and the in-process
// run asserts `isolation=in-process`. Without it, a config that failed to load would silently serve
// in-process and the parity check (process==in-process) would trivially pass, proving nothing.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { project, type TestProject } from '../helpers/project.ts';

process.setMaxListeners(50);

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const BIN = path.join(repoRoot, 'src', 'bin.ts');

// A nontrivial fixture: an aliased import + JSX usage (grep would miss `<B/>`), a type to expand.
const FILES = {
  'tsconfig.json':
    '{"compilerOptions":{"jsx":"react-jsx","strict":true,"module":"esnext","moduleResolution":"bundler"}}',
  'src/Button.tsx':
    'export type ButtonProps = { size: string; kind: "primary" | "ghost" };\n' +
    'export const Button = (p: ButtonProps) => <button>{p.size}</button>;\n',
  'src/App.tsx':
    "import { Button as B } from './Button';\n" +
    'export const App = () => <B size="lg" kind="primary" />;\n',
};

const configFor = (isolation: 'process' | 'in-process'): string =>
  `export default { daemon: { isolation: '${isolation}' } };\n`;

// Hermetic env: pass the parent environment through (PATH/HOME/etc.) but DROP every ambient
// `CODEMASTER_*` first — an inherited var (a dev's `CODEMASTER_ISOLATION`/`CODEMASTER_DEBUG`, a CI
// state-dir) could otherwise override the temp-config and make the isolation discriminator pass for
// the wrong reason. The temp workspace's config must be the SOLE source of isolation.
function cleanEnv(extra: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && !k.startsWith('CODEMASTER_')) env[k] = v;
  }
  return { ...env, ...extra };
}

async function spawnBridge(cwd: string, env: Record<string, string>): Promise<Client> {
  const client = new Client({ name: 'process-e2e', version: '0' });
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

function textOf(r: CallToolResult): string {
  return r.content.map((c) => (c.type === 'text' ? c.text : '')).join('');
}

async function callTool(
  client: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<string> {
  return textOf((await client.callTool({ name, arguments: args })) as CallToolResult);
}

// The op set driven over the wire. Repo-relative paths in the rendered output are already
// stable across roots; the scrub below only neutralizes the rare absolute leak + volatile pids.
async function runOps(client: Client, root: string): Promise<Record<string, string>> {
  return {
    find_definition: await callTool(client, 'find_definition', { name: 'Button', root }),
    find_usages: await callTool(client, 'find_usages', { name: 'Button', root }),
    expand_type: await callTool(client, 'expand_type', { name: 'ButtonProps', root }),
  };
}

// Scrub the ONLY volatile axes between two independent runs: the temp workspace root (absolute
// path), the temp state/sock dirs, and any pid. Anything else that differs IS a real divergence
// the parity assert must catch — so the scrub is deliberately narrow.
function scrub(text: string, roots: string[]): string {
  let out = text;
  for (const r of roots) out = out.split(r).join('<ROOT>');
  // The `~<hash>` SymbolId suffix is a per-file-version stamp (§6) — it differs between two
  // independent temp workspaces regardless of isolation, so it is a volatile axis, not a
  // process-vs-in-process divergence. Neutralize it narrowly (only inside a SymbolId).
  return out.replace(/(@[^\s]+?)~[0-9a-f]{6,}/g, '$1~<v>').replace(/\bpid=\d+/g, 'pid=<PID>');
}

const isolationOf = (status: string): string => /isolation=([\w-]+)/.exec(status)?.[1] ?? '<none>';

async function readdirEmpty(dir: string): Promise<boolean> {
  return !existsSync(dir) || readdirSync(dir).length === 0;
}

async function waitFor(cond: () => Promise<boolean>, budgetMs: number): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < budgetMs) {
    if (await cond()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return cond();
}

interface Run {
  ops: Record<string, string>;
  isolation: string;
  isolationAfter: string;
  socketCleaned: boolean;
  repo: TestProject;
  sockDir: string;
}

// One full wire run: temp workspace (own config) + own daemon (own socket-dir + fast idle TTL) +
// a real bridge. Returns the op outputs + the observed isolation, then tears the bridge down and
// waits for the daemon to idle-exit and unlink its socket (no lingering process/socket).
async function wireRun(isolation: 'process' | 'in-process'): Promise<Run> {
  const sockDir = mkdtempSync(path.join(tmpdir(), `cm-pm-${isolation}-`));
  const stateDir = mkdtempSync(path.join(tmpdir(), `cm-pm-state-${isolation}-`));
  const repo = await project({ ...FILES, 'codemaster.config.ts': configFor(isolation) });
  const env = cleanEnv({
    CODEMASTER_SOCK_DIR: sockDir,
    CODEMASTER_ENGINE_STATE_DIR: stateDir,
    CODEMASTER_MCP_IDLE_MS: '700',
  });

  const client = await spawnBridge(repo.root, env);
  let ops: Record<string, string> = {};
  let isolationSeen = '<none>';
  let isolationAfter = '<none>';
  let socketCleaned = false;
  try {
    isolationSeen = isolationOf(await callTool(client, 'status', {}));
    ops = await runOps(client, repo.root);
    // Re-read isolation AFTER the ops routed through the host: proves the ops ran against the same
    // resolved host (a fork-then-degrade would show a changed mode here), not just that host build
    // reported 'process' before any op dispatched.
    isolationAfter = isolationOf(await callTool(client, 'status', {}));
  } finally {
    await client.close().catch(() => undefined);
    // The daemon idle-exits (TTL 700ms) once the bridge is gone, unlinking its socket — bounded poll.
    // A non-empty sockDir here means a lingering daemon (and its process-mode child) — a leak.
    socketCleaned = await waitFor(() => readdirEmpty(sockDir), 8000);
    rmSync(stateDir, { recursive: true, force: true });
  }
  return { ops, isolation: isolationSeen, isolationAfter, socketCleaned, repo, sockDir };
}

test('live process-mode over the real bridge: forks the child AND matches in-process byte-for-byte', async () => {
  const proc = await wireRun('process');
  const inproc = await wireRun('in-process');
  try {
    // Positive discriminator (LOAD-BEARING): the process config actually built a process host, and
    // the in-process config an in-process one. A silent config-load failure would collapse both to
    // 'in-process' and make the parity check below vacuous.
    assert.equal(proc.isolation, 'process', 'process config forked a serve-engine child');
    assert.equal(inproc.isolation, 'in-process', 'in-process config stayed in the daemon');
    // The mode held ACROSS op dispatch — a fork-then-degrade-to-in-process would change this.
    assert.equal(proc.isolationAfter, 'process', 'process mode held through the op path');
    assert.equal(inproc.isolationAfter, 'in-process', 'in-process mode held through the op path');
    // No lingering daemon (and, in process mode, its serve-engine child) — the socket was unlinked.
    assert.ok(proc.socketCleaned, 'process daemon idle-exited + unlinked its socket (no leak)');
    assert.ok(
      inproc.socketCleaned,
      'in-process daemon idle-exited + unlinked its socket (no leak)',
    );

    // Each op produced a real answer (not an error/empty) in BOTH modes, then byte-parity across them.
    const roots = [proc.repo.root, inproc.repo.root];
    for (const op of Object.keys(proc.ops)) {
      const a = scrub(proc.ops[op] ?? '', roots);
      const b = scrub(inproc.ops[op] ?? '', roots);
      const bad = /bad args|DISPATCH|not active|internal tool/i;
      assert.doesNotMatch(a, bad, `${op}: process run healthy`);
      assert.doesNotMatch(b, bad, `${op}: in-process run healthy`);
      assert.equal(a, b, `${op}: process-mode output == in-process output over the wire`);
    }
    // Sanity that the fixture's semantic traps actually resolved (else parity of two empties lies).
    assert.match(
      scrub(proc.ops['find_usages'] ?? '', roots),
      /src\/App\.tsx/,
      'aliased <B/> found',
    );
    assert.match(scrub(proc.ops['expand_type'] ?? '', roots), /primary|ghost/, 'type expanded');
  } finally {
    rmSync(proc.repo.root, { recursive: true, force: true });
    rmSync(inproc.repo.root, { recursive: true, force: true });
    rmSync(proc.sockDir, { recursive: true, force: true });
    rmSync(inproc.sockDir, { recursive: true, force: true });
  }
});
