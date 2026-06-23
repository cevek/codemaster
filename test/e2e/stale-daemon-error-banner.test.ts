// §3.6 always-on, applied to the ERROR path: while the daemon's own source is behind disk, an
// op-level ERROR text response carries the "daemon restart" marker too — not just success renders.
// The highest-value case is `unknown_op` for a freshly-added op: the bridge lists it (its tool-list
// is its own `builtinOps()`), but the stale daemon never loaded it, so dispatch returns `unknown_op`
// — exactly where the restart remedy matters MOST. Before this fix that one response stayed
// marker-less (the tool said "no such op" when the truth was "your daemon predates it" — a §3
// lie-by-omission). The oracle drives the REAL MCP response path (serveMcp over an in-memory
// transport): a stub daemon synthesizes the `unknown_op` result (faithful — bridge-has-but-daemon-
// lacks is exactly a per-result error the facade must mark) and a request-level failure.
//
// Exit-seam (server.ts): `client.close()` is SAFE here — serveMcp derives its shutdown `exit` from
// the transport, so an injected (in-memory) transport defaults to a NO-OP exit, never `process.exit`.
// That structural guard is what stops onclose→exit(0) from hard-exiting the test file mid-run and
// masking a failed subtest as a green vacuum-pass. Proven discriminatingly by exit-seam-masking.test.ts.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { serveMcp } from '../../src/mcp/server.ts';
import type { OrchestratorApi } from '../../src/daemon/orchestrator-api.ts';

process.setMaxListeners(50);

/** How the stub daemon answers a `request`: a per-result `unknown_op` error (the stale-daemon
 *  freshly-added-op case), or a request-level failure (a transport/dispatch failure). */
type Mode = 'unknown_op' | 'request_fail';

/** Minimal orchestrator stub: a togglable `sourceStale`, and a `request` that returns the chosen
 *  failure shape — enough to exercise the facade's banner-on-error composition without an engine. */
function stubOrchestrator(stale: () => boolean, mode: Mode): OrchestratorApi {
  return {
    sourceStale: stale,
    dispose: async () => undefined,
    request: async (_cwd, _root, reqs) =>
      mode === 'request_fail'
        ? { ok: false, message: 'engine unavailable' }
        : {
            ok: true,
            results: reqs.map((r) => ({
              name: r.name,
              error: { kind: 'unknown_op' as const, message: `unknown op '${r.name}'` },
            })),
          },
    status: async () => ({}) as never,
  };
}

async function wire(stale: () => boolean, mode: Mode): Promise<Client> {
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await serveMcp(stubOrchestrator(stale, mode), 'test', { transport: serverT });
  const client = new Client({ name: 'test-client', version: '0' });
  await client.connect(clientT);
  return client;
}

function textOf(result: CallToolResult): string {
  const first = result.content[0];
  return first !== undefined && first.type === 'text' ? first.text : '';
}

const MARKER = /daemon code behind source/;

test('always-on: a STALE daemon carries the marker on an `unknown_op` ERROR response', async () => {
  const client = await wire(() => true, 'unknown_op');
  const r = (await client.callTool({
    name: 'find_definition',
    arguments: { q: 'X' },
  })) as CallToolResult;
  // RED before the fix: the error branch returned bare error text with no banner.
  assert.match(textOf(r), MARKER, 'a stale-daemon unknown_op must carry the restart remedy');
  assert.match(textOf(r), /unknown op/, 'the underlying error text is preserved');
});

test('always-on: a STALE daemon carries the marker on a request-level failure', async () => {
  const client = await wire(() => true, 'request_fail');
  const r = (await client.callTool({
    name: 'find_definition',
    arguments: {},
  })) as CallToolResult;
  assert.match(textOf(r), MARKER, 'a stale-daemon request failure must carry the restart remedy');
});

test('always-on: a STALE daemon carries the marker on a BATCH request-level failure', async () => {
  // §11 "every stale response" must hold for batch too: a batch that fails before producing rows
  // (server.ts batch `!outcome.ok`) had no banner while the per-op path now does — this mirrors it.
  const client = await wire(() => true, 'request_fail');
  const r = (await client.callTool({
    name: 'batch',
    arguments: { requests: [{ name: 'find_usages', args: { name: 'X' } }] },
  })) as CallToolResult;
  assert.match(
    textOf(r),
    MARKER,
    'a stale-daemon batch request failure must carry the restart remedy',
  );
});

test('§12: an ERROR `format:json` response suppresses the marker (a prefix would corrupt json)', async () => {
  const client = await wire(() => true, 'unknown_op');
  const r = (await client.callTool({
    name: 'find_definition',
    arguments: { format: 'json' },
  })) as CallToolResult;
  assert.doesNotMatch(textOf(r), MARKER, 'json mode must not prefix the banner onto an error');
});

test('no false positive: a FRESH daemon never marks an `unknown_op` ERROR response', async () => {
  const client = await wire(() => false, 'unknown_op');
  const r = (await client.callTool({
    name: 'find_definition',
    arguments: {},
  })) as CallToolResult;
  assert.doesNotMatch(textOf(r), MARKER, 'a fresh daemon must not nag on an error either');
});
