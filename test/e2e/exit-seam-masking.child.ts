// Child for exit-seam-masking.test.ts, run by it under a fresh `node --test` (outside the `*.test.ts`
// glob, so `npm test` never collects it). Wires serveMcp over an in-memory transport, runs ONE
// intentionally-failing subtest, then closes the client to trigger onclose→shutdown→exit. MASK=1
// forces `process.exit` (pre-fix); MASK=0 takes the shipped transport-derived default (no-op). The
// delay gives shutdown's async `dispose().finally(exit)` time to fire process.exit BEFORE the red
// assertion runs — so under MASK=1 the process is already gone (exit 0) and the failure never reports.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { serveMcp } from '../../src/mcp/server.ts';
import type { OrchestratorApi } from '../../src/daemon/orchestrator-api.ts';

const MASK = process.env.MASK === '1';
const stub = {
  sourceStale: () => false,
  buildId: () => undefined,
  dispose: async () => undefined,
  request: async (_cwd: string, _root: string | undefined, reqs: readonly { name: string }[]) => ({
    ok: true,
    results: reqs.map((r) => ({ name: r.name, result: { ok: true, data: {} } })),
  }),
  status: async () => ({}),
} as unknown as OrchestratorApi;

test('intentionally RED subtest — masked iff shutdown reaches process.exit', async () => {
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await serveMcp(
    stub,
    'test',
    MASK
      ? { serving: 'in-process', transport: serverT, exit: (c: number) => process.exit(c) }
      : { serving: 'in-process', transport: serverT },
  );
  const client = new Client({ name: 'masking-child', version: '0' });
  await client.connect(clientT);
  await client.callTool({ name: 'find_definition', arguments: { q: 'X' } });
  await client.close();
  await new Promise((r) => setTimeout(r, 250));
  assert.ok(false, 'this subtest is intentionally red and MUST be reported as a failure');
});
