// react-query plugin — oracle-backed (§16). The independent oracle is a fresh-from-cold
// `ts.Program` over the fixture, walked with a NAIVE by-name AST scan (no module resolution, no
// callArgShapes) — a different code path than the plugin's by-identity seam consumption. It
// derives the mutation→invalidate-key and query→key facts independently; the test asserts the
// `invalidations_for` op agrees, and that honesty holds: a dynamic queryKey segment is flagged
// (never resolved), a same-named decoy from another module is excluded, and the module resolved.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import test from 'node:test';
import ts from 'typescript';
import { projectFromDir } from '../helpers/repo-fixture.ts';
import { assertSpansValid } from '../helpers/project.ts';
import type { OpResult } from '../../src/ops/contracts.ts';

// ── Independent oracle: a cold Program + naive by-name walk ──────────────────────────────────
interface ColdFacts {
  /** enclosing function name → queryKey static segments + whether any segment is dynamic. */
  queryKeys: Map<string, { segments: string[]; hasDynamic: boolean }>;
  /** enclosing function name → the static string-segment arrays of its invalidate-family calls. */
  invalidateKeys: Map<string, string[][]>;
}

function coldFacts(root: string): ColdFacts {
  const configPath = path.join(root, 'tsconfig.json');
  const raw = ts.parseConfigFileTextToJson(configPath, readFileSync(configPath, 'utf8'));
  const parsed = ts.parseJsonConfigFileContent(raw.config, ts.sys, root);
  const program = ts.createProgram(parsed.fileNames, parsed.options);
  const queryKeys = new Map<string, { segments: string[]; hasDynamic: boolean }>();
  const invalidateKeys = new Map<string, string[][]>();

  const arrayOf = (e: ts.Expression | undefined): { segments: string[]; hasDynamic: boolean } => {
    if (e === undefined || !ts.isArrayLiteralExpression(e))
      return { segments: [], hasDynamic: true };
    const segments: string[] = [];
    let hasDynamic = false;
    for (const el of e.elements) {
      if (ts.isStringLiteral(el)) segments.push(el.text);
      else hasDynamic = true;
    }
    return { segments, hasDynamic };
  };
  const keyProp = (arg: ts.Expression | undefined): ts.Expression | undefined => {
    if (arg === undefined || !ts.isObjectLiteralExpression(arg)) return undefined;
    for (const p of arg.properties) {
      if (ts.isPropertyAssignment(p) && ts.isIdentifier(p.name) && p.name.text === 'queryKey') {
        return p.initializer;
      }
    }
    return undefined;
  };

  for (const sf of program.getSourceFiles()) {
    if (sf.isDeclarationFile || !sf.fileName.startsWith(root)) continue;
    for (const stmt of sf.statements) {
      if (!ts.isFunctionDeclaration(stmt) || stmt.name === undefined) continue;
      const fn = stmt.name.text;
      const visit = (node: ts.Node): void => {
        if (ts.isCallExpression(node)) {
          const callee = node.expression;
          if (
            ts.isIdentifier(callee) &&
            (callee.text === 'useQuery' || callee.text === 'useInfiniteQuery')
          ) {
            queryKeys.set(fn, arrayOf(keyProp(node.arguments[0])));
          } else if (
            ts.isPropertyAccessExpression(callee) &&
            callee.name.text === 'invalidateQueries'
          ) {
            const list = invalidateKeys.get(fn) ?? [];
            list.push(arrayOf(keyProp(node.arguments[0])).segments);
            invalidateKeys.set(fn, list);
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(stmt);
    }
  }
  return { queryKeys, invalidateKeys };
}

// ── op-result helpers ─────────────────────────────────────────────────────────────────────
interface Affect {
  name: string;
  confidence: string;
  queryKey: { segments: { kind: string; shape?: string }[]; confidence: string };
}
interface Edge {
  method: string;
  all: boolean;
  key?: { segments: { kind: string; value?: string }[]; confidence: string };
  affects: Affect[];
}
interface InvalidationsData {
  found: number;
  moduleResolved: boolean;
  dynamicKeyedQueries: number;
  mutations: { name: string; edges: Edge[] }[];
}

function dataOf(r: OpResult): InvalidationsData {
  assert.ok('result' in r, 'expected an op result, not a dispatch error');
  assert.ok(r.result.ok, 'op failed');
  return r.result.data as unknown as InvalidationsData;
}

test('invalidations_for: useCreateTodo → ["todos"] affects useTodos (certain), oracle-confirmed', async () => {
  const p = await projectFromDir('react-query');
  try {
    const oracle = coldFacts(p.root);
    // Oracle independently sees the relation we are about to assert through the op.
    assert.deepEqual(oracle.invalidateKeys.get('useCreateTodo'), [['todos']]);
    assert.deepEqual(oracle.queryKeys.get('useTodos'), { segments: ['todos'], hasDynamic: false });

    const r = await p.op('invalidations_for', { mutation: 'useCreateTodo' });
    const data = dataOf(r);
    assert.equal(data.moduleResolved, true, 'module must resolve, else everything demotes');
    assert.equal(data.found, 1);
    const edges = data.mutations[0]?.edges ?? [];
    assert.equal(edges.length, 1);
    const edge = edges[0];
    assert.ok(edge !== undefined);
    assert.equal(edge.method, 'invalidate');
    assert.equal(edge.all, false);
    assert.equal(edge.key?.confidence, 'certain');
    assert.deepEqual(
      edge.key?.segments.map((s) => s.value),
      ['todos'],
    );
    // Affects useTodos certain; NOT useTodo (different prefix) nor the decoy notAQuery.
    const names = edge.affects.map((a) => a.name).sort();
    assert.deepEqual(names, ['useTodos']);
    assert.equal(edge.affects[0]?.confidence, 'certain');
    // useDynamic has a computed key — excluded from `affects` under a concrete prefix, but its
    // existence is reported (no faked completeness, §3.4), never silently matched to everything.
    assert.equal(data.dynamicKeyedQueries, 1);
    assert.ok(assertSpansValid(p.root, r) > 0, 'proof spans must validate against source');
  } finally {
    await p.dispose();
  }
});

test('invalidations_for: useTouchTodo → ["todo"] affects useTodo whose key segment is flagged dynamic', async () => {
  const p = await projectFromDir('react-query');
  try {
    const r = await p.op('invalidations_for', { mutation: 'useTouchTodo' });
    const data = dataOf(r);
    assert.equal(data.found, 1);
    const edge = data.mutations[0]?.edges[0];
    assert.ok(edge !== undefined);
    assert.deepEqual(
      edge.key?.segments.map((s) => s.value),
      ['todo'],
    );
    const affected = edge.affects.find((a) => a.name === 'useTodo');
    assert.ok(affected !== undefined, 'useTodo must be affected by the ["todo"] prefix');
    assert.equal(affected.confidence, 'certain', 'static prefix match is certain');
    // The affected query key itself is partial — its second segment is a DYNAMIC identifier,
    // flagged, never resolved to a guessed value (§3.3).
    assert.equal(affected.queryKey.confidence, 'partial');
    assert.equal(affected.queryKey.segments[0]?.kind, 'static');
    assert.equal(affected.queryKey.segments[1]?.kind, 'dynamic');
    assert.equal(affected.queryKey.segments[1]?.shape, 'identifier');
  } finally {
    await p.dispose();
  }
});

test('invalidations_for: a template-segment invalidation key is partial, with no false match', async () => {
  const p = await projectFromDir('react-query');
  try {
    const r = await p.op('invalidations_for', { mutation: 'useUpdateUser' });
    const data = dataOf(r);
    assert.equal(data.found, 1);
    const edge = data.mutations[0]?.edges[0];
    assert.ok(edge !== undefined);
    assert.equal(edge.key?.confidence, 'partial', 'a template segment demotes the key');
    assert.equal(edge.key?.segments[0]?.value, 'user');
    assert.equal(edge.key?.segments[1]?.kind, 'dynamic');
    assert.deepEqual(edge.affects, [], 'no query is keyed under user — honest empty, not a guess');
  } finally {
    await p.dispose();
  }
});

test('invalidations_for: a same-named hook from another module is NOT a mutation (import-anchored)', async () => {
  const p = await projectFromDir('react-query');
  try {
    const r = await p.op('invalidations_for', { mutation: 'notAMutation' });
    const data = dataOf(r);
    assert.equal(data.found, 0, 'other-lib useMutation must not be detected as react-query');
  } finally {
    await p.dispose();
  }
});

test('invalidations_for: exact:true matches only a same-length key — no over-claim on a longer key', async () => {
  const p = await projectFromDir('react-query');
  try {
    const data = dataOf(await p.op('invalidations_for', { mutation: 'useExactTouch' }));
    assert.equal(data.found, 1);
    const edge = data.mutations[0]?.edges[0];
    assert.ok(edge !== undefined);
    assert.deepEqual(
      edge.key?.segments.map((s) => s.value),
      ['todo'],
    );
    // useTodo (['todo', id]) is LONGER → exact must exclude it. Prefix-matching would have
    // claimed it `certain` — that is the confident lie this guards.
    assert.deepEqual(edge.affects, []);
  } finally {
    await p.dispose();
  }
});

test('invalidations_for: a predicate filter caps an otherwise-certain match at partial', async () => {
  const p = await projectFromDir('react-query');
  try {
    const data = dataOf(await p.op('invalidations_for', { mutation: 'usePredicateInvalidate' }));
    assert.equal(data.found, 1);
    const edge = data.mutations[0]?.edges[0];
    assert.ok(edge !== undefined);
    const todos = edge.affects.find((a) => a.name === 'useTodos');
    assert.ok(todos !== undefined, 'useTodos still in the upper-bound set');
    // The static ['todos']↔['todos'] match would be certain, but the unevaluable predicate may
    // exclude it at runtime → capped at partial, never asserted certain (§3.3).
    assert.equal(todos.confidence, 'partial');
  } finally {
    await p.dispose();
  }
});

// ── list registries (the generic `list` op routes to react-query) ───────────────────────────
interface ListEntryRow {
  key: string;
  kind: string;
  name?: string;
  confidence: string;
  provenance: string;
  segments?: { dynamic: boolean; value?: string }[];
}
interface ListData {
  found: boolean;
  owner?: string;
  entries: ListEntryRow[];
}
function listOf(r: OpResult): ListData {
  assert.ok('result' in r && r.result.ok, 'list op failed');
  return r.result.data as unknown as ListData;
}

test('list mutations / queries: detected by react-query, decoys excluded, provenance honest', async () => {
  const p = await projectFromDir('react-query');
  try {
    const mut = listOf(await p.op('list', { registry: 'mutations' }));
    assert.equal(mut.found, true);
    assert.equal(mut.owner, 'react-query');
    const mutNames = mut.entries.map((e) => e.name).sort();
    assert.deepEqual(mutNames, [
      'useCreateTodo',
      'useExactTouch',
      'usePredicateInvalidate',
      'useTouchTodo',
      'useUpdateUser',
    ]);
    assert.ok(mut.entries.every((e) => e.provenance === 'heuristic:react-query'));
    assert.ok(!mutNames.includes('notAMutation'), 'decoy must not be a mutation');

    const q = listOf(await p.op('list', { registry: 'queries' }));
    const qNames = q.entries.map((e) => e.name).sort();
    assert.deepEqual(qNames, ['useDynamic', 'useTodo', 'useTodos']);
    assert.ok(!qNames.includes('notAQuery'), 'decoy must not be a query');
  } finally {
    await p.dispose();
  }
});

test('list queryKeys: composite keys per-segment with dynamic flags, never flattened/guessed', async () => {
  const p = await projectFromDir('react-query');
  try {
    const keys = listOf(await p.op('list', { registry: 'queryKeys' }));
    // useTodo: ['todo', id] — first segment static, second dynamic (flagged, no guessed value).
    const todo = keys.entries.find(
      (e) => e.segments?.[0]?.value === 'todo' && e.segments.length === 2,
    );
    assert.ok(todo !== undefined, 'useTodo key must be listed');
    assert.equal(todo.segments?.[1]?.dynamic, true);
    assert.equal(
      todo.segments?.[1]?.value,
      undefined,
      'a dynamic segment carries no guessed value',
    );
    assert.equal(todo.confidence, 'partial');
    // useDynamic: an opaque (non-array) key → a single dynamic segment, confidence dynamic.
    const opaque = keys.entries.find((e) => e.confidence === 'dynamic');
    assert.ok(opaque !== undefined, 'the opaque key must be listed, flagged dynamic');
    assert.deepEqual(opaque.segments, [{ dynamic: true }]);
  } finally {
    await p.dispose();
  }
});

test('freshness: a newly written mutation is picked up on the next query, never served stale', async () => {
  const p = await projectFromDir('react-query');
  try {
    const before = listOf(await p.op('list', { registry: 'mutations' }));
    assert.ok(!before.entries.some((e) => e.name === 'useFreshMutation'));
    // The derived plugin has no own file state — it memoizes on ts.freshness(); the read-time
    // guard reindexes ts when the tree drifts, bumping that fingerprint so the memo recomputes.
    p.write(
      'src/fresh.ts',
      [
        "import { useMutation } from '@tanstack/react-query';",
        'export function useFreshMutation() {',
        '  return useMutation<void, void>({ mutationFn: () => Promise.resolve() });',
        '}',
        '',
      ].join('\n'),
    );
    const after = listOf(await p.op('list', { registry: 'mutations' }));
    assert.ok(
      after.entries.some((e) => e.name === 'useFreshMutation'),
      'the new mutation must be reindexed on read, never a stale registry',
    );
  } finally {
    await p.dispose();
  }
});
