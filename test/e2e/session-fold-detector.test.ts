// Detector for repeated static prose (§12 session folding), driven through the real MCP facade over a
// real engine. STATIC is established independently of the lesson registry: a fragment of ≥60 chars
// common to the answers for two DIFFERENT targets, each from its own fresh session, is text no target
// decides. Within ONE session the second answer must then carry none of those fragments — whatever
// produced them, registered or not. A new explanation an op starts emitting turns this red until it
// is registered as a lesson.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { serveMcp } from '../../src/mcp/server.ts';
import { project, type TestProject } from '../helpers/project.ts';

process.setMaxListeners(80);

const MIN = 60;
const C = '{"strict":true,"module":"esnext","moduleResolution":"bundler","jsx":"react-jsx"}';
const FILES = {
  'tsconfig.json': `{"compilerOptions":${C},"include":["src"]}`,
  'tsconfig.test.json': `{"compilerOptions":${C},"include":["test"]}`,
  'pkg/nested/tsconfig.json': `{"compilerOptions":${C}}`,
  'pkg/nested/x.ts': 'export const nestedOnly = 1;\n',
  'src/a.ts':
    'export const alpha = 1;\nexport const beta = 2;\nexport function gamma(){ return alpha + beta; }\nexport const deadOne = 3;\nexport const deadTwo = 4;\n',
  'src/b.ts':
    "import { alpha, beta, gamma } from './a';\nexport const d = alpha + beta + gamma();\n",
  'test/t.ts': "import { alpha, beta } from '../src/a';\nexport const t = alpha + beta;\n",
};

/** [op, args for target A, args for target B] — two targets the same prose can explain. */
const MATRIX: [string, Record<string, unknown>, Record<string, unknown>][] = [
  ['find_usages', { name: 'alpha' }, { name: 'beta' }],
  ['find_definition', { name: 'zzzMissing' }, { name: 'yyyMissing' }],
  ['search_symbol', { query: 'gam', syntactic: true }, { query: 'alp', syntactic: true }],
  ['source', { name: 'gamma', syntactic: true }, { name: 'alpha', syntactic: true }],
  ['symbols_overview', { query: 'alp' }, { query: 'gam' }],
  ['source', { name: 'noSuchA', syntactic: true }, { name: 'noSuchB', syntactic: true }],
  [
    'source',
    { file: 'src/a.ts', line: 3, col: 40, syntactic: true },
    { file: 'src/b.ts', line: 2, col: 30, syntactic: true },
  ],
  ['find_unused_exports', { pathInclude: ['src/a.ts'] }, { pathInclude: ['src/b.ts'] }],
];

async function session(p: TestProject): Promise<(op: string, args: object) => Promise<string>> {
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await serveMcp(p.orchestrator, 'test', {
    serving: 'in-process',
    transport: serverT,
    session: true,
  });
  const client = new Client({ name: 'detector', version: '0' });
  await client.connect(clientT);
  return async (name, args) => {
    const r = (await client.callTool({
      name,
      arguments: { ...args, root: p.root },
    })) as CallToolResult;
    const first = r.content[0];
    return first !== undefined && first.type === 'text' ? first.text : '';
  };
}

/** Static-looking text that is a FACT of this repo/answer, not an explanation — it must repeat. */
const FACTS: readonly [RegExp, string][] = [
  [/!! CANNOT CLAIM unsafe=/, 'the claim marker itself — an alarm, only its note folds'],
  [/did not load \(/, 'names the unloaded config(s) — a repo fact on each row it demotes'],
  [/: walked \d+ of the \d+ source file/, 'the scan scope counts'],
];

/** Maximal common substrings of ≥MIN chars between the lines of two texts. */
function commonFragments(a: string, b: string): string[] {
  const out = new Set<string>();
  const long = (t: string): string[] => t.split('\n').filter((l) => l.length >= MIN);
  for (const x of long(a)) {
    for (const y of long(b)) {
      let prev = new Uint16Array(y.length + 1);
      for (let i = 1; i <= x.length; i++) {
        const cur = new Uint16Array(y.length + 1);
        for (let j = 1; j <= y.length; j++) {
          if (x[i - 1] !== y[j - 1]) continue;
          cur[j] = (prev[j - 1] ?? 0) + 1;
          const ends = i === x.length || j === y.length || x[i] !== y[j];
          if (ends && (cur[j] ?? 0) >= MIN) out.add(x.slice(i - (cur[j] ?? 0), i));
        }
        prev = cur;
      }
    }
  }
  return [...out];
}

test('a second answer in one session repeats no static explanation from the first', async () => {
  const p = await project(FILES);
  try {
    const repeats: string[] = [];
    let staticSeen = 0;
    for (const [op, a, b] of MATRIX) {
      const fresh1 = await (await session(p))(op, a);
      const fresh2 = await (await session(p))(op, b);
      const fragments = commonFragments(fresh1, fresh2);
      staticSeen += fragments.length;
      const run = await session(p);
      await run(op, a);
      const second = await run(op, b);
      for (const f of fragments) {
        if (FACTS.some(([re]) => re.test(f))) continue;
        if (second.includes(f)) repeats.push(`${op}: ${f}`);
      }
    }
    assert.ok(
      staticSeen > 0,
      'the matrix produces static prose at all (else this test is vacuous)',
    );
    assert.deepEqual(repeats, [], `static prose repeated in-session:\n${repeats.join('\n')}`);
  } finally {
    await p.dispose();
  }
});
