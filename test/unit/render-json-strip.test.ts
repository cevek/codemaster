// json mode (`format:'json'`) renders the envelope verbatim EXCEPT the render-only `~shape` tags
// are stripped from `data` (gardrail a). The strip is a deep COPY (the live data keeps its tags for
// the text path / sql projector — §19 tear-free) and preserves non-meta key ORDER (the tag is
// appended last), so the json payload is byte-identical to the pre-tag shape. This locks that — the
// strip is a new transform on EVERY op's json, so it must not pollute or reorder.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderResultJson } from '../../src/format/render/render-result.ts';
import { ok } from '../../src/common/result/construct.ts';
import { tag, stripShapeTags } from '../../src/common/shape-tag/tag.ts';
import type { JsonValue } from '../../src/core/json.ts';

test('json mode strips every ~shape tag (nested), nothing leaks to the agent', () => {
  const data: JsonValue = {
    usages: [
      tag('usage', {
        span: { file: 'a.ts', line: 1, col: 1 },
        role: 'call',
        confidence: 'certain',
      }),
    ],
    definition: tag('symbol', { id: 'ts:X@a.ts:1:1', name: 'X', kind: 'function' }),
    mutations: [
      tag('rq-mutation', {
        id: 'ts:m@a.ts:1:1',
        edges: [
          tag('rq-edge', {
            method: 'invalidate',
            affects: [tag('rq-affected', { id: 'ts:q@a.ts:1:1' })],
          }),
        ],
      }),
    ],
  };
  const json = renderResultJson(ok(data));
  assert.doesNotMatch(json, /~shape/, 'no render tag may reach json output');
  // Round-trips to the same structure with tags removed (deep).
  const parsed = JSON.parse(json) as { data: JsonValue };
  assert.deepEqual(parsed.data, stripShapeTags(data));
});

test('the strip preserves non-meta key ORDER (tag was appended last) → byte-identical shape', () => {
  // tag() appends `~shape` last; stripping it must leave the other keys in their original order, so
  // an agent diffing json against a pre-tag baseline sees no churn.
  const row = tag('symbol', { id: 'ts:X@a.ts:1:1', name: 'X', kind: 'function', callable: true });
  const stripped = stripShapeTags(row) as Record<string, JsonValue>;
  assert.deepEqual(Object.keys(stripped), ['id', 'name', 'kind', 'callable']);
});

test('stripShapeTags does not mutate the source (live data keeps its tags — §19)', () => {
  const row = tag('usage', { role: 'call' });
  const copy = stripShapeTags([row]);
  assert.equal((row as Record<string, JsonValue>)['~shape'], 'usage', 'source row still tagged');
  assert.doesNotMatch(JSON.stringify(copy), /~shape/, 'the returned copy is clean');
});
