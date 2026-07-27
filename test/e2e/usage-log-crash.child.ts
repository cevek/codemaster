// Child process for the crash-telemetry oracle (usage-log-crash.test.ts). Drives the REAL
// `serveMcp` handler with the REAL file usage logger, then dies mid-dispatch: the stub
// orchestrator SIGKILLs its own process synchronously inside `request` — provably AFTER the
// pre-dispatch breadcrumb is stamped and BEFORE the post-dispatch telemetry write, with no timer
// to tune and no race. SIGKILL is uncatchable, so nothing on the way out can rescue the record.

import { z } from 'zod';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { serveMcp } from '../../src/mcp/server.ts';
import { defaultUsageLogger } from '../../src/support/usage-log/default.ts';
import type { Orchestrator } from '../../src/daemon/orchestrator.ts';
import { defineOp } from '../../src/ops/registry.ts';

const mode = process.argv[2] ?? 'crash';
const op = defineOp({
  name: 'find_definition',
  summary: 'stub',
  mutating: false,
  requires: [],
  argsSchema: z.looseObject({}),
  argsHint: '{ }',
  run: async () => ({ ok: true, data: {} }),
});

const orchestrator = {
  sourceStale: () => false,
  dispose: async () => undefined,
  status: async () => ({}) as never,
  request: async (_cwd: string, _root: string | undefined, reqs: readonly { name: string }[]) => {
    if (mode === 'crash') process.kill(process.pid, 'SIGKILL');
    return {
      ok: true as const,
      results: reqs.map((r) => ({ name: r.name, result: { ok: true as const, data: {} } })),
    };
  },
} as unknown as Orchestrator;

const [clientT, serverT] = InMemoryTransport.createLinkedPair();
await serveMcp(orchestrator, 'test', {
  transport: serverT,
  usage: defaultUsageLogger(),
  ops: [op],
});
const client = new Client({ name: 'crash-child', version: '0' });
await client.connect(clientT);
await client.callTool({ name: 'find_definition', arguments: { name: 'Widget' } });
// Only the non-crash arm reaches here (the discriminating control: a call that COMPLETES must
// leave no breadcrumb behind).
process.exit(0);
