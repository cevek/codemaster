// `callArgShapes` (scan2, §5-L2) — the generic call-arg classification plugins/react-query consumes.
// Oracle (§16): hand-curated argument SHAPES on a react-query-shaped fixture (queryKey segments,
// the invalidateQueries-in-onSuccess association), plus invariant 1 on every emitted span. The
// by-IDENTITY model is exercised with a same-named DECOY (`useQuery` from another module) that must
// NOT match — the distinctness a by-name scan can't give. cold==warm: an edit + reindex re-shapes
// the memoized result and equals a fresh boot.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { project } from '../helpers/project.ts';
import { createTsPlugin } from '../../src/plugins/ts/plugin.ts';
import { extractText } from '../../src/common/span/extract-text.ts';
import type { RepoRelPath } from '../../src/core/brands.ts';
import type { TsPluginApi } from '../../src/plugins/ts/plugin.ts';
import type {
  CallMatchSpec,
  ShapedCall,
  ValueShape,
} from '../../src/plugins/ts/call-scan-shared.ts';

const COMPILER = '{"strict":true,"module":"esnext","moduleResolution":"bundler"}';

const TODOS =
  "import { useQuery, useMutation, useQueryClient } from './rq';\n" +
  "import { useQuery as otherUseQuery } from './other';\n" +
  "const orgId = 'o';\n" +
  'declare function fetchTodos(): unknown;\n' +
  'declare function createTodo(): unknown;\n' +
  'export function useTodos() {\n' +
  "  return useQuery({ queryKey: ['todos', orgId], queryFn: fetchTodos });\n" +
  '}\n' +
  'export function useCount() {\n' +
  "  return useQuery({ queryKey: ['count', 1, `p-${orgId}`] });\n" +
  '}\n' +
  'export function useCreateTodo() {\n' +
  '  const qc = useQueryClient();\n' +
  '  return useMutation({\n' +
  '    mutationFn: createTodo,\n' +
  '    onSuccess: () => {\n' +
  "      qc.invalidateQueries({ queryKey: ['todos'] });\n" +
  '    },\n' +
  '  });\n' +
  '}\n' +
  "export function decoy() {\n  return otherUseQuery({ queryKey: ['nope'] });\n}\n";

const FILES = {
  'tsconfig.json': `{"compilerOptions":${COMPILER},"include":["src"]}`,
  'src/rq.ts':
    'export function useQuery(o: unknown): unknown { return o; }\n' +
    'export function useMutation(o: unknown): unknown { return o; }\n' +
    'export function useQueryClient(): { invalidateQueries(o: unknown): void } {\n' +
    '  return { invalidateQueries() {} };\n}\n',
  'src/other.ts': 'export function useQuery(o: unknown): unknown { return o; }\n',
  'src/todos.ts': TODOS,
};

const SPEC: CallMatchSpec = {
  functions: ['useQuery', 'useMutation', 'useQueryClient', 'invalidateQueries'],
  module: 'src/rq.ts',
  hook: 'useQueryClient',
};

const find = (calls: readonly ShapedCall[], fn: string, encloser: string): ShapedCall | undefined =>
  calls.find((c) => c.fn === fn && c.encloser.name === encloser);

const prop = (shape: ValueShape | undefined, key: string): ValueShape | undefined =>
  shape !== undefined && shape.kind === 'object'
    ? shape.props.find((p) => p.key === key)?.value
    : undefined;

/** Invariant 1, recursively: every {file,line,col,…,text} node equals the live source. */
function assertAllSpans(root: string, value: unknown): void {
  if (Array.isArray(value)) {
    for (const v of value) assertAllSpans(root, v);
    return;
  }
  if (typeof value !== 'object' || value === null) return;
  const v = value as Record<string, unknown>;
  if (
    typeof v['file'] === 'string' &&
    typeof v['text'] === 'string' &&
    typeof v['line'] === 'number'
  ) {
    const source = readFileSync(path.join(root, v['file']), 'utf8');
    assert.equal(
      extractText(source, v as never),
      v['text'],
      `span drift at ${v['file']}:${String(v['line'])}`,
    );
  }
  for (const child of Object.values(v)) assertAllSpans(root, child);
}

test('by-identity: queryKey segments, the decoy exclusion, and invalidate↔mutation association', async () => {
  const p = await project(FILES);
  const plugin: TsPluginApi = createTsPlugin(p.root);
  try {
    const res = plugin.callArgShapes(SPEC);
    assert.equal(res.mode, 'identity');
    assert.equal(res.moduleResolved, true);
    const calls = res.calls;

    // Decoy: `useQuery` imported from './other' is a DIFFERENT symbol — by-identity excludes it.
    assert.ok(
      !calls.some((c) => c.encloser.name === 'decoy'),
      'the other-module decoy must not match',
    );

    // useTodos: queryKey is ['todos', orgId] → [string certain, identifier dynamic], array dynamic.
    const todos = find(calls, 'useQuery', 'useTodos');
    assert.ok(todos !== undefined, 'useQuery in useTodos found');
    assert.equal(todos.encloser.kind, 'function');
    const tKey = prop(todos.args[0], 'queryKey');
    assert.ok(tKey !== undefined && tKey.kind === 'array', 'queryKey is an array');
    assert.equal(tKey.confidence, 'dynamic'); // worstOf a dynamic identifier segment
    assert.deepEqual(
      tKey.elements.map((e) => e.kind),
      ['string', 'identifier'],
    );
    assert.equal(tKey.elements[0]?.kind === 'string' ? tKey.elements[0].value : undefined, 'todos');

    // useCount: ['count', 1, `p-${orgId}`] → [string, number, template].
    const count = find(calls, 'useQuery', 'useCount');
    const cKey = count !== undefined ? prop(count.args[0], 'queryKey') : undefined;
    assert.ok(cKey !== undefined && cKey.kind === 'array');
    assert.deepEqual(
      cKey.elements.map((e) => e.kind),
      ['string', 'number', 'template'],
    );

    // invalidateQueries (qc.invalidateQueries) — matched via the useQueryClient binding (provenance
    // namespace), shares the enclosing decl with the mutation, AND links to it by enclosingCallId.
    const mutation = find(calls, 'useMutation', 'useCreateTodo');
    const invalidate = find(calls, 'invalidateQueries', 'useCreateTodo');
    assert.ok(mutation !== undefined && invalidate !== undefined);
    assert.equal(invalidate.provenance, 'namespace');
    assert.equal(
      invalidate.enclosingCallId,
      mutation.callId,
      'invalidate links to its mutation call',
    );
    const iKey = prop(invalidate.args[0], 'queryKey');
    assert.ok(iKey !== undefined && iKey.kind === 'array');
    assert.equal(iKey.elements[0]?.kind === 'string' ? iKey.elements[0].value : undefined, 'todos');

    assertAllSpans(p.root, calls);
  } finally {
    await plugin.dispose();
    await p.dispose();
  }
});

test('by-name mode (no module) resolves and matches the written callee', async () => {
  const p = await project(FILES);
  const plugin: TsPluginApi = createTsPlugin(p.root);
  try {
    const res = plugin.callArgShapes({ functions: ['useMutation'] });
    assert.equal(res.mode, 'by-name');
    assert.equal(res.moduleResolved, true);
    assert.ok(find(res.calls, 'useMutation', 'useCreateTodo') !== undefined);
  } finally {
    await plugin.dispose();
    await p.dispose();
  }
});

test('cold == warm: a queryKey edit + reindex re-shapes the memoized result and equals a fresh boot', async () => {
  const p = await project(FILES);
  const warm: TsPluginApi = createTsPlugin(p.root);
  try {
    assert.equal(
      find(warm.callArgShapes(SPEC).calls, 'invalidateQueries', 'useCreateTodo') !== undefined,
      true,
    );

    const edited = TODOS.replace(
      "qc.invalidateQueries({ queryKey: ['todos'] });",
      "qc.invalidateQueries({ queryKey: ['todos', orgId] });",
    );
    p.write('src/todos.ts', edited);
    await warm.reindex(['src/todos.ts' as RepoRelPath]);

    const warmAfter = warm.callArgShapes(SPEC).calls;
    const iKey = prop(
      find(warmAfter, 'invalidateQueries', 'useCreateTodo')?.args[0] as ValueShape,
      'queryKey',
    );
    assert.ok(
      iKey !== undefined && iKey.kind === 'array' && iKey.elements.length === 2,
      'memo invalidated → 2 segments',
    );

    const cold: TsPluginApi = createTsPlugin(p.root);
    try {
      const sort = (cs: readonly ShapedCall[]): ShapedCall[] =>
        [...cs].sort((a, b) => a.callId.localeCompare(b.callId));
      assert.deepEqual(sort(warmAfter), sort(cold.callArgShapes(SPEC).calls));
    } finally {
      await cold.dispose();
    }
  } finally {
    await warm.dispose();
    await p.dispose();
  }
});
