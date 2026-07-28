
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { serveMcp } from "/Users/cody/Dev/worktrees/codemaster/m1-envelope-disclosure/src/mcp/server.ts";

const MASK = process.env.MASK === '1';
const stub = {
  sourceStale: () => false,
  dispose: async () => undefined,
  request: async (_cwd, _root, reqs) => ({
    ok: true,
    results: reqs.map((r) => ({ name: r.name, result: { ok: true, data: {} } })),
  }),
  status: async () => ({}),
};

test('intentionally RED subtest — masked iff shutdown reaches process.exit', async () => {
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  // MASK arm forces process.exit even over the injected transport; fix arm omits exit → no-op default.
  await serveMcp(stub, 'test', MASK ? { transport: serverT, exit: (c) => process.exit(c) } : { transport: serverT });
  const client = new Client({ name: 'masking-child', version: '0' });
  await client.connect(clientT);
  await client.callTool({ name: 'find_definition', arguments: { q: 'X' } });
  // Closing the client closes the linked server transport → server.onclose = shutdown → exit().
  await client.close();
  // Let shutdown's async dispose().finally(exit) fire. Under MASK=1 process.exit(0) wins here and
  // the assertion below never runs; under MASK=0 the no-op exit lets the red assertion surface.
  await new Promise((r) => setTimeout(r, 250));
  assert.ok(false, 'this subtest is intentionally red and MUST be reported as a failure');
});
