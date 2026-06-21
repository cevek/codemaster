// Usage telemetry (spec usage-telemetry): serveMcp records every call's request+response to
// success.jsonl / fail.jsonl. The load-bearing oracle is the CLASSIFICATION: a `Result` with
// ok:false (a ToolFailure) renders through a plain text() with no isError, so an isError-only
// check would mis-file it as success. The test drives serveMcp over a real transport with a real
// file logger to a temp dir, then reads + JSON.parses each file — disk is the ground truth.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { z } from 'zod';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { serveMcp } from '../../src/mcp/server.ts';
import { createFileUsageLogger } from '../../src/support/usage-log/create.ts';
import type { UsageLogEntry } from '../../src/support/usage-log/entry.ts';
import type { Orchestrator } from '../../src/daemon/orchestrator.ts';
import type { OpResult } from '../../src/ops/contracts.ts';
import { defineOp, type AnyOpDefinition } from '../../src/ops/registry.ts';
import type { Clock } from '../../src/common/async/clock.ts';

process.setMaxListeners(50);

const fixedClock: Clock = { now: () => 1_700_000_000_000, schedule: () => () => undefined };

/** Minimal op definitions so the per-op tools (find_definition / tool_fail / dispatch_fail) are
 *  advertised and routable; the stub orchestrator below crafts each one's result (its `run` is
 *  never reached — dispatch is stubbed at the orchestrator). */
function stubOp(name: string): AnyOpDefinition {
  return defineOp({
    name,
    summary: `stub ${name}`,
    mutating: false,
    requires: [],
    argsSchema: z.looseObject({}),
    argsHint: '{ }',
    run: async () => ({ ok: true, data: {} }),
  });
}
const STUB_OPS = ['find_definition', 'tool_fail', 'dispatch_fail'].map(stubOp);

/** Stub orchestrator whose `request` returns a crafted OpResult per op name, so each
 *  classification arm (ok / ToolFailure / DispatchError) can be exercised in isolation. */
function stubOrchestrator(): Orchestrator {
  const request: Orchestrator['request'] = async (_cwd, _root, reqs) => {
    const results: OpResult[] = reqs.map((r) => byName(r.name));
    return { ok: true, results };
  };
  return {
    sourceStale: () => false,
    dispose: async () => undefined,
    request,
    status: async () => ({}) as never,
  } as unknown as Orchestrator;
}

function byName(name: string): OpResult {
  if (name === 'tool_fail') {
    // A ToolFailure: ok:false inside the Result — renders via text(), NO isError.
    return { name, result: { ok: false, failure: { tool: 'tsserver', message: 'boom' } } };
  }
  if (name === 'dispatch_fail') {
    return { name, error: { kind: 'op_threw', message: 'threw' } };
  }
  return { name, result: { ok: true, data: { hit: name } } };
}

async function wire(dir: string): Promise<Client> {
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await serveMcp(stubOrchestrator(), 'test', {
    transport: serverT,
    usage: createFileUsageLogger(dir),
    clock: fixedClock,
    ops: STUB_OPS,
  });
  const client = new Client({ name: 'test-client', version: '0' });
  await client.connect(clientT);
  return client;
}

function readEntries(file: string): UsageLogEntry[] {
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as UsageLogEntry);
}

test('usage-log: a successful op lands in success.jsonl with request + response captured', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'cm-usage-'));
  const client = await wire(dir);
  await client.callTool({ name: 'find_definition', arguments: { q: 'X' } });

  const ok = readEntries(path.join(dir, 'success.jsonl'));
  const fail = readEntries(path.join(dir, 'fail.jsonl'));
  assert.equal(fail.length, 0, 'no fail entry for a successful op');
  assert.equal(ok.length, 1);
  const e = ok[0];
  assert.ok(e);
  assert.equal(e.ok, true);
  // The per-op tool's name IS the op name — telemetry records it as the tool, ops still lists it.
  assert.equal(e.tool, 'find_definition');
  assert.deepEqual(e.ops, ['find_definition']);
  assert.equal(e.ts, 1_700_000_000_000);
  assert.deepEqual(e.args, { q: 'X' }, 'the flat per-op arguments are recorded');
  assert.ok(e.response.length > 0, 'the response is recorded');
});

test('usage-log: a ToolFailure (ok:false, no isError) is filed as FAIL, not success', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'cm-usage-'));
  const client = await wire(dir);
  await client.callTool({ name: 'tool_fail', arguments: {} });

  const ok = readEntries(path.join(dir, 'success.jsonl'));
  const fail = readEntries(path.join(dir, 'fail.jsonl'));
  assert.equal(ok.length, 0, 'a ToolFailure must NOT be classified as success');
  assert.equal(fail.length, 1);
  assert.equal(fail[0]?.ok, false);
  assert.equal(fail[0]?.isError ?? false, false, 'the rendered response had no isError flag');
});

test('usage-log: a DispatchError op is filed as fail', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'cm-usage-'));
  const client = await wire(dir);
  await client.callTool({ name: 'dispatch_fail', arguments: {} });

  assert.equal(readEntries(path.join(dir, 'success.jsonl')).length, 0);
  const fail = readEntries(path.join(dir, 'fail.jsonl'));
  assert.equal(fail.length, 1);
  assert.equal(fail[0]?.ok, false);
});

test('usage-log: a per-op bad-arg (wrong-typed reserved flag) is filed as fail', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'cm-usage-'));
  const client = await wire(dir);
  // `apply` is a reserved flag extracted at the facade; a non-boolean fails the boundary before
  // dispatch — a fail, recorded against the op's own tool name.
  await client.callTool({ name: 'find_definition', arguments: { apply: 'notbool' } });

  assert.equal(readEntries(path.join(dir, 'success.jsonl')).length, 0);
  const fail = readEntries(path.join(dir, 'fail.jsonl'));
  assert.equal(fail.length, 1);
  assert.equal(fail[0]?.tool, 'find_definition');
});

test('usage-log: a batch with one failing op is filed as fail, recording every op name', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'cm-usage-'));
  const client = await wire(dir);
  await client.callTool({
    name: 'batch',
    arguments: {
      requests: [
        { name: 'find_definition', args: {} },
        { name: 'tool_fail', args: {} },
      ],
    },
  });

  assert.equal(
    readEntries(path.join(dir, 'success.jsonl')).length,
    0,
    'any failing op fails the batch',
  );
  const fail = readEntries(path.join(dir, 'fail.jsonl'));
  assert.equal(fail.length, 1);
  assert.deepEqual(fail[0]?.ops, ['find_definition', 'tool_fail']);
});
