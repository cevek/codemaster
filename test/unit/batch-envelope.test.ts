// t-479871 — a `batch` request written in the natural FLAT form `{op:'find_usages', name:'Plugin'}`
// (the standalone tools take flat args) must dispatch find_usages with name=Plugin — NOT silently
// strip `op` and dispatch the `name` VALUE ('Plugin') as the op. Two oracles: (1) the normalizer
// rewrites the flat envelope to the canonical `{name,args}` shape the schema expects; (2) the
// normalized request, run through the real dispatch, returns the SAME result as the canonical form.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { project, type TestProject } from '../helpers/project.ts';
import { normalizeBatchEnvelope } from '../../src/mcp/op-tools.ts';
import { batchToolSchema } from '../../src/mcp/schema.ts';
import type { OpRequest, OpResult } from '../../src/ops/contracts.ts';

const FILES = {
  'tsconfig.json': '{"compilerOptions":{"strict":true}}',
  'src/plugin.ts': 'export interface Plugin { id: string; }\n',
  'src/use.ts': "import type { Plugin } from './plugin';\nexport const p: Plugin = { id: 'x' };\n",
};

test('flat {op,name} envelope → canonical {name,args}', () => {
  assert.deepEqual(normalizeBatchEnvelope({ op: 'find_usages', name: 'Plugin' }), {
    name: 'find_usages',
    args: { name: 'Plugin' },
  });
});

test('flat form lifts reserved flags to the request level, not into args', () => {
  assert.deepEqual(
    normalizeBatchEnvelope({ op: 'find_usages', name: 'Plugin', verbosity: 'terse', as: 't0' }),
    { name: 'find_usages', args: { name: 'Plugin' }, verbosity: 'terse', as: 't0' },
  );
});

test('mixed {op, args:{…}} uses the canonical args object directly (no double-nesting)', () => {
  assert.deepEqual(normalizeBatchEnvelope({ op: 'search_symbol', args: { query: 'X' } }), {
    name: 'search_symbol',
    args: { query: 'X' },
  });
});

test('a canonical {name,args} envelope is passed through untouched', () => {
  const canonical = { name: 'find_usages', args: { name: 'Plugin' } };
  assert.deepEqual(normalizeBatchEnvelope(canonical), canonical);
});

test('non-object / arrays pass through (schema then reports the real error)', () => {
  assert.equal(normalizeBatchEnvelope(null), null);
  assert.equal(normalizeBatchEnvelope(42), 42);
  assert.deepEqual(normalizeBatchEnvelope([1, 2]), [1, 2]);
});

test('normalized flat envelope validates AND dispatches == the canonical form', async () => {
  const flat = batchToolSchema.safeParse({
    requests: [normalizeBatchEnvelope({ op: 'find_usages', name: 'Plugin' })],
  });
  assert.ok(flat.success, 'normalized flat form validates against the batch schema');

  const p: TestProject = await project(FILES);
  try {
    const flatOut = await p.request(flat.data.requests as OpRequest[]);
    const canonOut = await p.request([{ name: 'find_usages', args: { name: 'Plugin' } }]);
    const okData = (r: readonly OpResult[]): string => {
      const first = r[0];
      assert.ok(
        first && 'result' in first && first.result.ok,
        `dispatch failed: ${JSON.stringify(first)}`,
      );
      return JSON.stringify(first.result.data);
    };
    assert.equal(okData(flatOut), okData(canonOut), 'flat {op,name} == canonical {name,args}');
  } finally {
    await p.dispose();
  }
});
