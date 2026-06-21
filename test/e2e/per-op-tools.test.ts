// Per-op MCP tools end-to-end (§11): the facade exposes one tool per op (+ status + batch), and a
// per-op `tools/call` drives the SAME dispatch path the former `op` tool did. The oracle is the
// REAL pipeline — `serveMcp` over an in-memory transport in front of a genuine `project()`
// orchestrator — compared against the direct orchestrator dispatch (not a golden). Covers: the
// tool-list shape, behavioral parity, honest `unavailable` for an inactive plugin, and batch+sql.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { serveMcp } from '../../src/mcp/server.ts';
import { renderResult } from '../../src/format/render/render-result.ts';
import { project, type TestProject } from '../helpers/project.ts';

process.setMaxListeners(50);

const FILES = {
  'tsconfig.json':
    '{"compilerOptions":{"jsx":"react-jsx","strict":true,"module":"esnext","moduleResolution":"bundler"}}',
  'src/Button.tsx': 'export const Button = (p:{size:string}) => <button>{p.size}</button>;',
  'src/App.tsx': 'import {Button as B} from \'./Button\'; export const App = () => <B size="lg"/>;',
};

function textOf(r: CallToolResult): string {
  const f = r.content[0];
  return f !== undefined && f.type === 'text' ? f.text : '';
}

async function wire(p: TestProject): Promise<Client> {
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await serveMcp(p.orchestrator, 'test', { transport: serverT });
  const client = new Client({ name: 'test-client', version: '0' });
  await client.connect(clientT);
  return client;
}

test('tools/list advertises one tool per op + status + batch, and NOT the monolithic op tool', async () => {
  const p = await project(FILES);
  try {
    const client = await wire(p);
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    assert.ok(names.includes('find_usages'), 'a read op is a tool');
    assert.ok(names.includes('rename_symbol'), 'a mutating op is a tool');
    assert.ok(names.includes('status') && names.includes('batch'), 'status + batch survive');
    assert.ok(!names.includes('op'), 'the single op dispatcher is gone');
    const fu = tools.find((t) => t.name === 'find_usages');
    assert.equal(fu?.inputSchema?.type, 'object', 'per-op tool carries a typed inputSchema');
    const props = Object.keys((fu?.inputSchema?.properties as object) ?? {});
    assert.ok(props.includes('symbols') && props.includes('verbosity'), 'args + flags advertised');
  } finally {
    await p.dispose();
  }
});

test('tools/call find_usages == direct dispatch (catches the aliased <B/> grep would miss)', async () => {
  const p = await project(FILES);
  try {
    const client = await wire(p);
    const r = (await client.callTool({
      name: 'find_usages',
      arguments: { name: 'Button', root: p.root },
    })) as CallToolResult;
    const viaTool = textOf(r);
    assert.ok(viaTool.includes('src/App.tsx'), 'finds the aliased import usage');

    const direct = await p.request([{ name: 'find_usages', args: { name: 'Button' } }]);
    const d0 = direct[0];
    assert.ok(d0 !== undefined && 'result' in d0, 'direct dispatch produced a result');
    assert.equal(viaTool, renderResult(d0.result, 'terse'), 'per-op render == direct render');
  } finally {
    await p.dispose();
  }
});

test('Postel intake still runs on the per-op args-remainder (alias not eaten by reserved-extract)', async () => {
  const p = await project(FILES);
  try {
    const client = await wire(p);
    // `symbol` is an intake alias for `name`; reserved-extract runs BEFORE intake, so this proves
    // the alias survives the facade split AND that intake rewrites the remainder (disclosed as
    // `interpreted: symbol→name`). A regression here would silently strip the alias.
    const r = (await client.callTool({
      name: 'find_usages',
      arguments: { symbol: 'Button', root: p.root },
    })) as CallToolResult;
    const t = textOf(r);
    assert.ok(t.includes('src/App.tsx'), 'the aliased arg resolved to a real query');
    assert.match(t, /interpreted: symbol→name/, 'intake disclosure surfaces on the per-op path');
  } finally {
    await p.dispose();
  }
});

test('an op whose plugin is inactive returns an honest "not active", never a fabricated result', async () => {
  const p = await project(FILES); // no i18n config → the i18n plugin is not loaded
  try {
    const client = await wire(p);
    const r = (await client.callTool({
      name: 'find_unused_i18n_keys',
      arguments: { root: p.root },
    })) as CallToolResult;
    assert.match(textOf(r), /needs plugin\(s\) \[i18n\]|not active/i);
  } finally {
    await p.dispose();
  }
});

test('batch + sql still works over the per-op-tool facade', async () => {
  const p = await project(FILES);
  try {
    const client = await wire(p);
    const r = (await client.callTool({
      name: 'batch',
      arguments: {
        root: p.root,
        requests: [{ name: 'find_usages', args: { name: 'Button' }, as: 'u' }],
        sql: 'SELECT count(*) AS n FROM u',
      },
    })) as CallToolResult;
    const t = textOf(r);
    assert.doesNotMatch(t, /bad args|unknown|DISPATCH/i, 'sql path is healthy');
    assert.match(t, /\bn\b/, 'the SELECT alias is projected');
    assert.match(t, /\d/, 'a count row is returned');
  } finally {
    await p.dispose();
  }
});
