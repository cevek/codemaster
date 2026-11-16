// Two machine-checked invariants of MCP session folding (§12), each over a whole scenario rather than
// one case:
//  1. DELIVERY — whenever a delivered answer carries `short [id]`, the full text of that lesson is in
//     some answer the client actually received (cancelled calls and failed sends deliver nothing).
//     A fold is the facade's only evidence of what it believes was shown, so this is "counted as
//     shown ⇒ delivered", observed from the client.
//  2. REVERSIBILITY — for every uncapped answer, replacing each `short [id]` with the lesson's full
//     text reproduces the session-less answer byte for byte: folding never changes anything else.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { serveMcp } from '../../src/mcp/server.ts';
import type { OrchestratorApi } from '../../src/daemon/orchestrator-api.ts';
import type { JsonValue } from '../../src/core/json.ts';
import { LESSONS } from '../../src/mcp/lessons.ts';
import { lessonRef } from '../../src/common/lesson/lesson.ts';
import { ALL_PROGRAM_LESSON, IMPORTS_COLLAPSED_LESSON } from '../../src/ops/find-usages-view.ts';
import { project } from '../helpers/project.ts';

process.setMaxListeners(80);

const NOTE = `allProgram=tsconfig.json: ${ALL_PROGRAM_LESSON.full}`;
const NOTE2 = `imports: 2 collapsed${IMPORTS_COLLAPSED_LESSON.full}`;
const BIG = Array.from({ length: 3000 }, (_, i) => `src/file-${i}.ts:1:1`);

function violations(delivered: readonly string[]): string[] {
  const all = delivered.join('\n\u0000\n');
  return LESSONS.filter((l) => all.includes(lessonRef(l)) && !all.includes(l.full)).map(
    (l) => l.id,
  );
}

test('DELIVERY: every folded lesson was delivered in full in some received answer', async () => {
  let release: () => void = () => undefined;
  const orch: OrchestratorApi = {
    sourceStale: () => false,
    buildId: () => undefined,
    dispose: async () => undefined,
    status: async () => ({}) as never,
    request: async (_cwd, _root, reqs) => {
      const names = reqs.map((r) => (r.args as Record<string, JsonValue>)['name']);
      if (names.includes('slow')) await new Promise<void>((r) => (release = r));
      return {
        ok: true,
        results: reqs.map((r) => {
          const name = (r.args as Record<string, JsonValue>)['name'];
          const data: JsonValue =
            name === 'big' ? { items: BIG, notes: [NOTE, NOTE2] } : { notes: [NOTE, NOTE2] };
          return { name: r.name, result: { ok: true, data } };
        }),
      };
    },
  };
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  const send = serverT.send.bind(serverT);
  let failNext = false;
  serverT.send = async (message, options) => {
    if (failNext && 'result' in message && 'content' in (message.result as object)) {
      failNext = false;
      throw new Error('send failed');
    }
    return send(message, options);
  };
  await serveMcp(orch, 'test', { serving: 'daemon', transport: serverT, session: true });
  const client = new Client({ name: 'inv', version: '0' });
  await client.connect(clientT);

  const delivered: string[] = [];
  const call = async (
    name: string,
    args: Record<string, unknown>,
    opts: object = {},
  ): Promise<void> => {
    const r = (await client.callTool({ name, arguments: args }, undefined, opts)) as CallToolResult;
    const first = r.content[0];
    delivered.push(first !== undefined && first.type === 'text' ? first.text : '');
    assert.deepEqual(violations(delivered), [], `after ${name} ${JSON.stringify(args)}`);
  };
  const undelivered = async (run: () => Promise<unknown>): Promise<void> => {
    await run().catch(() => undefined);
    await new Promise((r) => setTimeout(r, 50));
  };

  // A failed send, then a cancelled call: neither may count.
  failNext = true;
  await undelivered(() =>
    client.callTool({ name: 'find_usages', arguments: { name: 'a' } }, undefined, { timeout: 200 }),
  );
  const ac = new AbortController();
  const cancelled = client
    .callTool({ name: 'find_usages', arguments: { name: 'slow' } }, undefined, {
      signal: ac.signal,
    })
    .catch(() => undefined);
  await new Promise((r) => setTimeout(r, 20));
  ac.abort();
  await undelivered(() => cancelled);
  release();
  await new Promise((r) => setTimeout(r, 50));
  // A capped section first: its full copies are cut, the next section must carry them.
  await call('batch', {
    requests: [
      { name: 'find_usages', args: { name: 'big' } },
      { name: 'find_usages', args: { name: 'x' } },
    ],
  });
  await call('batch', {
    requests: [
      { name: 'find_usages', args: { name: 'x' }, format: 'json' },
      { name: 'find_usages', args: { name: 'y' } },
    ],
  });
  await call('find_usages', { name: 'big' });
  await call('find_usages', { name: 'z' });
});

const C = '{"strict":true,"module":"esnext","moduleResolution":"bundler","jsx":"react-jsx"}';
const FILES = {
  'tsconfig.json': `{"compilerOptions":${C},"include":["src"]}`,
  'tsconfig.test.json': `{"compilerOptions":${C},"include":["test"]}`,
  'pkg/nested/tsconfig.json': `{"compilerOptions":${C}}`,
  'pkg/nested/x.ts': 'export const nestedOnly = 1;\n',
  'src/a.ts':
    'export const alpha = 1;\nexport const beta = 2;\nexport function gamma(){ return alpha + beta; }\nexport const deadOne = 3;\n',
  'src/b.ts':
    "import { alpha, beta, gamma } from './a';\nexport const d = alpha + beta + gamma();\n",
  'test/t.ts': "import { alpha, beta } from '../src/a';\nexport const t = alpha + beta;\n",
};

/** Calls replayed in the same order against a session and a session-less server. */
const CORPUS: [string, Record<string, unknown>][] = [
  // First: a multi-target answer whose shared disclosure note is shown for the first time.
  ['source', { targets: [{ name: 'alpha' }, { name: 'beta' }] }],
  ['find_usages', { name: 'alpha' }],
  ['find_usages', { name: 'beta' }],
  ['find_usages', { symbols: ['alpha', 'beta', 'gamma'] }],
  ['find_usages', { name: 'alpha', groupBy: 'enclosing' }],
  ['find_definition', { name: 'zzzMissing' }],
  ['find_definition', { name: 'yyyMissing' }],
  ['search_symbol', { query: 'gam', syntactic: true }],
  ['search_symbol', { query: 'alp', syntactic: true, exportedOnly: true }],
  ['source', { name: 'gamma', syntactic: true }],
  ['source', { targets: [{ name: 'alpha' }, { name: 'beta' }] }],
  ['source', { targets: [{ name: 'gamma' }, { name: 'd' }] }],
  ['source', { name: 'missA', file: 'src/a.ts' }],
  ['source', { name: 'missB', file: 'src/b.ts' }],
  ['source', { name: 'noSuchA', syntactic: true }],
  ['symbols_overview', { query: 'alp' }],
  ['symbols_overview', { summary: true }],
  ['find_unused_exports', {}],
  ['find_unused_exports', { pathInclude: ['src/a.ts'] }],
  ['importers_of', { file: 'src/a.ts' }],
  [
    'batch',
    {
      requests: [
        { name: 'find_usages', args: { name: 'gamma' } },
        { name: 'find_definition', args: { name: 'q1' } },
        { name: 'find_definition', args: { name: 'q2' } },
      ],
    },
  ],
  ['find_usages', { name: 'alpha', sql: 'SELECT file FROM t' }],
];

async function replay(p: Awaited<ReturnType<typeof project>>, session: boolean): Promise<string[]> {
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await serveMcp(p.orchestrator, 'test', { serving: 'in-process', transport: serverT, session });
  const client = new Client({ name: 'inv', version: '0' });
  await client.connect(clientT);
  const out: string[] = [];
  for (const [name, args] of CORPUS) {
    const r = (await client.callTool({
      name,
      arguments: { ...args, root: p.root },
    })) as CallToolResult;
    const first = r.content[0];
    out.push(first !== undefined && first.type === 'text' ? first.text : '');
  }
  return out;
}

function expand(text: string): string {
  let out = text;
  for (const l of LESSONS) out = out.split(lessonRef(l)).join(l.full);
  return out;
}

test('REVERSIBILITY: expanding every fold reproduces the session-less answer byte for byte', async () => {
  const p = await project(FILES);
  try {
    const off = await replay(p, false);
    const on = await replay(p, true);
    let folded = 0;
    for (let i = 0; i < CORPUS.length; i++) {
      const a = on[i] ?? '';
      if (a.includes('!! OUTPUT CAPPED')) continue;
      if (a !== off[i]) folded++;
      assert.equal(expand(a), off[i], `${CORPUS[i]?.[0]} ${JSON.stringify(CORPUS[i]?.[1])}`);
    }
    assert.ok(folded >= 5, `the corpus folds at all (${folded} answers differ)`);
  } finally {
    await p.dispose();
  }
});
