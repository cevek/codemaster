// Session prose folding on the real MCP facade (§11/§12): `serveMcp {session:true}` over an in-memory
// transport. An explanation shown in full once per connection repeats as its short claim + `[id]`;
// a cut that removed the full text never counts as shown; json, a second client and a session-less
// server are untouched. The oracle is the lesson registry's own text (what the producer emits)
// compared against what reaches the client — never the facade's own bookkeeping.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { serveMcp } from '../../src/mcp/server.ts';
import type { OrchestratorApi } from '../../src/daemon/orchestrator-api.ts';
import type { JsonValue } from '../../src/core/json.ts';
import { ALL_PROGRAM_LESSON } from '../../src/ops/find-usages-view.ts';
import { SURFACE_WALK_LESSON } from '../../src/plugins/ts/syntactic-scope.ts';
import { preEditLesson } from '../../src/format/render/render-status.ts';
import { project } from '../helpers/project.ts';

process.setMaxListeners(80);

const NOTE = `allProgram=tsconfig.json: ${ALL_PROGRAM_LESSON.full}`;
const REF = `${ALL_PROGRAM_LESSON.short} [${ALL_PROGRAM_LESSON.id}]`;

interface Stub {
  data?: (args: Record<string, JsonValue>, root: string | undefined) => JsonValue;
  stale?: () => boolean;
  build?: () => string | undefined;
}

function stub(s: Stub = {}): OrchestratorApi {
  return {
    sourceStale: s.stale ?? (() => false),
    buildId: s.build ?? (() => undefined),
    dispose: async () => undefined,
    request: async (_cwd, root, reqs) => ({
      ok: true,
      results: reqs.map((r) => ({
        name: r.name,
        result: {
          ok: true,
          data: s.data?.(r.args as Record<string, JsonValue>, r.root ?? root) ?? { notes: [NOTE] },
        },
      })),
    }),
    status: async () => ({}) as never,
  };
}

async function connect(orch: OrchestratorApi, session = true): Promise<Client> {
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await serveMcp(orch, 'test', { serving: 'daemon', transport: serverT, session });
  const client = new Client({ name: 'test-client', version: '0' });
  await client.connect(clientT);
  return client;
}

async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
  const r = (await client.callTool({ name, arguments: args })) as CallToolResult;
  const first = r.content[0];
  return first !== undefined && first.type === 'text' ? first.text : '';
}

test('first answer carries the full explanation; the repeat carries the short claim + [id]', async () => {
  const client = await connect(stub());
  const first = await call(client, 'find_usages', { name: 'a' });
  const second = await call(client, 'find_usages', { name: 'b' });
  assert.ok(first.includes(ALL_PROGRAM_LESSON.full), first);
  assert.ok(!second.includes(ALL_PROGRAM_LESSON.full), second);
  assert.ok(second.includes(`allProgram=tsconfig.json: ${REF}`), 'the fact stays, the prose folds');
});

test('a session-less server (the default) and a second client both see the full text', async () => {
  const plain = await connect(stub(), false);
  await call(plain, 'find_usages', { name: 'a' });
  assert.ok((await call(plain, 'find_usages', { name: 'b' })).includes(ALL_PROGRAM_LESSON.full));

  const orch = stub();
  const a = await connect(orch);
  await call(a, 'find_usages', { name: 'a' });
  const b = await connect(orch);
  assert.ok((await call(b, 'find_usages', { name: 'a' })).includes(ALL_PROGRAM_LESSON.full));
});

test('batch: the first section keeps the full text, a later section folds it', async () => {
  const client = await connect(stub());
  const text = await call(client, 'batch', {
    requests: [
      { name: 'find_usages', args: { name: 'a' } },
      { name: 'find_usages', args: { name: 'b' } },
    ],
  });
  const [s0, s1] = text.split('\n\n[1] ');
  assert.ok(s0?.includes(ALL_PROGRAM_LESSON.full), text);
  assert.ok(s1 !== undefined && !s1.includes(ALL_PROGRAM_LESSON.full) && s1.includes(REF), text);
});

test('format:json is never folded and never stamped', async () => {
  const client = await connect(stub({ build: () => '0.1.0 @abc123def' }));
  for (const name of ['a', 'b']) {
    const body = await call(client, 'find_usages', { name, format: 'json' });
    const parsed = JSON.parse(body) as { data: { notes: string[] } };
    assert.deepEqual(parsed.data.notes, [NOTE]);
  }
});

test('a full text cut by the render cap does not count as shown', async () => {
  // `items` first, the note last: the note sits at the END of the bulk the per-op cap trims.
  const big = Array.from({ length: 3000 }, (_, i) => `src/file-${i}.ts:1:1`);
  let capped = true;
  const client = await connect(
    stub({ data: () => (capped ? { items: big, note: NOTE } : { note: NOTE }) }),
  );
  const first = await call(client, 'find_usages', { name: 'a' });
  assert.match(first, /!! OUTPUT CAPPED/, 'the fixture reaches the cap');
  assert.ok(!first.includes(ALL_PROGRAM_LESSON.full), 'the note was cut from the first answer');
  capped = false;
  const second = await call(client, 'find_usages', { name: 'b' });
  assert.ok(second.includes(ALL_PROGRAM_LESSON.full), 'never delivered → shown in full now');
});

test('a root-scoped explanation folds per root', async () => {
  const note = `!! SURFACE = FILESYSTEM WALK, not the git listing${SURFACE_WALK_LESSON.full}`;
  const client = await connect(stub({ data: () => ({ surface: note }) }));
  const a1 = await call(client, 'search_symbol', { query: 'x', root: '/repo/a' });
  const a2 = await call(client, 'search_symbol', { query: 'x', root: '/repo/a' });
  const b1 = await call(client, 'search_symbol', { query: 'x', root: '/repo/b' });
  assert.ok(a1.includes(SURFACE_WALK_LESSON.full));
  assert.ok(!a2.includes(SURFACE_WALK_LESSON.full) && a2.includes('[surface-walk]'), a2);
  assert.ok(b1.includes(SURFACE_WALK_LESSON.full), 'another root states its own fact in full');
});

test('the stale banner stays on every stale answer, short after its first full showing', async () => {
  const client = await connect(stub({ stale: () => true }));
  const full = preEditLesson('daemon');
  const first = await call(client, 'find_usages', { name: 'a' });
  assert.ok(first.startsWith(full.full), first);
  for (const name of ['b', 'c']) {
    const text = await call(client, 'find_usages', { name });
    const line = text.split('\n')[0] ?? '';
    assert.equal(line, `${full.short} [${full.id}]`);
    assert.ok(line.startsWith('!! PRE-EDIT codemaster') && line.length <= 250, line);
  }
});

test('the build stamp: once per session, again when it changes; an unknown build is not stamped', async () => {
  let build: string | undefined;
  const client = await connect(stub({ build: () => build }));
  assert.doesNotMatch(await call(client, 'find_usages', { name: 'a' }), /^codemaster v/);
  build = '0.1.0 @unknown (daemon predates build ids)';
  assert.match(await call(client, 'find_usages', { name: 'a' }), /^codemaster v0\.1\.0 @unknown/);
  build = '0.1.0 @abc123def';
  assert.match(
    await call(client, 'find_usages', { name: 'a' }),
    /^codemaster v0\.1\.0 @abc123def\n/,
  );
  assert.doesNotMatch(await call(client, 'find_usages', { name: 'a' }), /^codemaster v/);
});

test('status: a repeat states the catalogue as unchanged and names the concepts; full:true lists all', async () => {
  const p = await project({
    'tsconfig.json': '{"compilerOptions":{"strict":true}}',
    'src/a.ts': 'export const a = 1;\n',
  });
  try {
    const client = await connect(p.orchestrator);
    const first = await call(client, 'status', { root: p.root });
    const second = await call(client, 'status', { root: p.root });
    const full = await call(client, 'status', { root: p.root, full: true });
    assert.match(first, /\nconcepts:\n  targets: /);
    assert.match(second, /ops \(\d+\): same as shown earlier this session for /);
    assert.match(second, /concepts: shown earlier this session — ids: targets, dials, /);
    assert.ok(second.length < first.length / 3, `${second.length} vs ${first.length}`);
    assert.match(full, /\nops \(\d+\):\n  search_symbol /, 'full:true always lists the catalogue');
    assert.doesNotMatch(full, /shown earlier this session/);
  } finally {
    await p.dispose();
  }
});

test('status {concept} prints the full text whatever the session saw; an unknown id lists ids', async () => {
  const client = await connect(stub());
  assert.equal(
    await call(client, 'status', { concept: 'all-program' }),
    `[all-program] ${ALL_PROGRAM_LESSON.full}`,
  );
  assert.match(
    await call(client, 'status', { concept: 'nope' }),
    /^concept 'nope' unknown — ids: .*all-program/,
  );
});
