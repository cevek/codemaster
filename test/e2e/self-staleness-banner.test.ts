// Self-staleness banner is ALWAYS-ON on the op/batch path (§3.6 applied to the tool): while the
// daemon's own source is behind disk, EVERY op/batch text response carries the "daemon restart"
// marker — not just the first. The earlier one-shot latch warned once then served pre-edit behavior
// silently (the §3.6 cardinal sin in a multi-edit dogfood session). The oracle drives the REAL MCP
// response path (serveMcp over an in-memory transport) — `project().op()` bypasses serveMcp (it
// calls the orchestrator directly), so the banner, which lives in the facade, is only exercised
// here. Discriminating: on the one-shot code responses #2/#3 carry NO marker (red); always-on → all
// carry it (green).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { serveMcp } from '../../src/mcp/server.ts';
import type { OrchestratorApi } from '../../src/daemon/orchestrator-api.ts';

process.setMaxListeners(50);

/** Minimal orchestrator stub: a togglable `sourceStale`, and `request` echoing each op as an ok
 *  result — enough to exercise the facade's banner composition without warming an engine. */
function stubOrchestrator(stale: () => boolean): OrchestratorApi {
  return {
    sourceStale: stale,
    dispose: async () => undefined,
    request: async (_cwd, _root, reqs) => ({
      ok: true,
      results: reqs.map((r) => ({ name: r.name, result: { ok: true, data: { hit: r.name } } })),
    }),
    status: async () => ({}) as never,
  };
}

async function wire(stale: () => boolean): Promise<Client> {
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await serveMcp(stubOrchestrator(stale), 'test', { transport: serverT });
  const client = new Client({ name: 'test-client', version: '0' });
  await client.connect(clientT);
  return client;
}

function textOf(result: CallToolResult): string {
  const first = result.content[0];
  return first !== undefined && first.type === 'text' ? first.text : '';
}

const MARKER = /daemon code behind source/;

test('always-on: a STALE daemon carries the marker on EVERY op text response (not just the first)', async () => {
  const client = await wire(() => true);
  for (let i = 1; i <= 3; i++) {
    const r = (await client.callTool({
      name: 'find_definition',
      arguments: { q: 'X' },
    })) as CallToolResult;
    // RED on the one-shot latch: responses #2 and #3 came back marker-less.
    assert.match(textOf(r), MARKER, `op response #${i} must carry the staleness marker`);
  }
});

test('always-on: a STALE daemon carries the marker on EVERY batch text response', async () => {
  const client = await wire(() => true);
  for (let i = 1; i <= 3; i++) {
    const r = (await client.callTool({
      name: 'batch',
      arguments: { requests: [{ name: 'find_usages', args: { name: 'X' } }] },
    })) as CallToolResult;
    assert.match(textOf(r), MARKER, `batch response #${i} must carry the staleness marker`);
  }
});

test('§12: an op `format:json` response suppresses the marker AND stays valid JSON', async () => {
  const client = await wire(() => true);
  const r = (await client.callTool({
    name: 'find_definition',
    arguments: { format: 'json' },
  })) as CallToolResult;
  const body = textOf(r);
  assert.doesNotMatch(body, MARKER, 'a prefix line would corrupt the single bare-JSON payload');
  assert.doesNotThrow(() => JSON.parse(body) as unknown, 'json mode must remain parseable');
});

test('no false positive: a FRESH daemon never emits the marker on op/batch', async () => {
  const client = await wire(() => false);
  const op = (await client.callTool({
    name: 'find_definition',
    arguments: {},
  })) as CallToolResult;
  const batch = (await client.callTool({
    name: 'batch',
    arguments: { requests: [{ name: 'find_usages', args: { name: 'X' } }] },
  })) as CallToolResult;
  assert.doesNotMatch(textOf(op), MARKER, 'a fresh daemon must not nag on op');
  assert.doesNotMatch(textOf(batch), MARKER, 'a fresh daemon must not nag on batch');
});
