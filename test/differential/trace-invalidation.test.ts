// `trace_invalidation` — oracle-backed (§16). The independent oracle is a fresh-from-cold
// `ts.Program` over the fixture, walked with a NAIVE by-name AST scan (NOT the plugins' seams —
// that would be circular). It derives, on its own checker, three facts the trace claims:
//   (1) useCreateTodo fires a STATIC invalidate(['todos']) and a BROAD invalidateQueries() (no key);
//   (2) useTodos's queryKey is ['todos'] and TodoList calls useTodos;
//   (3) TodoList is mounted at exactly two `<TodoList/>` JSX sites (App.tsx), plus one VALUE read
//       (`const Aliased = TodoList`) that is NOT a JSX mount.
// The test asserts the op's hop chain agrees AND that honesty holds — the broad edge and the opaque
// mount are flagged (never bridged), and (THE #1 TRUST POINT) the re-rendering component is the
// subscriber TodoList, NEVER the App that merely places <TodoList/>.
//
// Discriminators (red→green): a build that (a) drops the broad-edge dynamic flag, (b) counts App as
// re-rendering, (c) treats the `= TodoList` value read as a clean mount, or (d) labels the
// hook→component edge anything but `type` provenance — each fails a distinct assertion below.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import test from 'node:test';
import ts from 'typescript';
import { projectFromDir } from '../helpers/repo-fixture.ts';
import { assertSpansValid } from '../helpers/project.ts';
import type { OpResult } from '../../src/ops/contracts.ts';

// ── Independent oracle: a cold Program + naive walk ──────────────────────────────────────────
interface OracleFacts {
  createTodoStaticKeys: string[][]; // static invalidate keys in useCreateTodo
  createTodoHasBroad: boolean; // a no-key invalidateQueries() in useCreateTodo
  todosKey: string[]; // useTodos's queryKey static segments
  todoListCallsUseTodos: boolean;
  todoListJsxMountCount: number; // `<TodoList` JSX tags in App.tsx
}

function oracle(root: string): OracleFacts {
  const configPath = path.join(root, 'tsconfig.json');
  const raw = ts.parseConfigFileTextToJson(configPath, readFileSync(configPath, 'utf8'));
  const parsed = ts.parseJsonConfigFileContent(raw.config, ts.sys, root);
  const program = ts.createProgram(parsed.fileNames, parsed.options);

  const createTodoStaticKeys: string[][] = [];
  let createTodoHasBroad = false;
  let todosKey: string[] = [];
  let todoListCallsUseTodos = false;
  let todoListJsxMountCount = 0; // `<TodoList/>` JSX elements (AST, comment-immune)

  const staticSegments = (e: ts.Expression | undefined): string[] | undefined => {
    if (e === undefined || !ts.isArrayLiteralExpression(e)) return undefined;
    const segs: string[] = [];
    for (const el of e.elements) if (ts.isStringLiteral(el)) segs.push(el.text);
    return segs;
  };
  const keyProp = (arg: ts.Expression | undefined): ts.Expression | undefined => {
    if (arg === undefined || !ts.isObjectLiteralExpression(arg)) return undefined;
    for (const p of arg.properties)
      if (ts.isPropertyAssignment(p) && ts.isIdentifier(p.name) && p.name.text === 'queryKey')
        return p.initializer;
    return undefined;
  };

  for (const sf of program.getSourceFiles()) {
    if (sf.isDeclarationFile || !sf.fileName.startsWith(root)) continue;
    const inTodoList = sf.fileName.endsWith('TodoList.tsx');
    const visit = (node: ts.Node, fn: string): void => {
      let scope = fn;
      if (ts.isFunctionDeclaration(node) && node.name !== undefined) scope = node.name.text;
      if (ts.isJsxSelfClosingElement(node) || ts.isJsxOpeningElement(node)) {
        if (ts.isIdentifier(node.tagName) && node.tagName.text === 'TodoList') {
          todoListJsxMountCount++;
        }
      }
      if (ts.isCallExpression(node)) {
        const callee = node.expression;
        if (ts.isIdentifier(callee) && callee.text === 'useQuery' && scope === 'useTodos') {
          todosKey = staticSegments(keyProp(node.arguments[0])) ?? [];
        }
        if (ts.isIdentifier(callee) && callee.text === 'useTodos' && inTodoList) {
          todoListCallsUseTodos = true;
        }
        if (
          ts.isPropertyAccessExpression(callee) &&
          callee.name.text === 'invalidateQueries' &&
          scope === 'useCreateTodo'
        ) {
          const seg = staticSegments(keyProp(node.arguments[0]));
          if (node.arguments.length === 0) createTodoHasBroad = true;
          else if (seg !== undefined) createTodoStaticKeys.push(seg);
        }
      }
      ts.forEachChild(node, (c) => visit(c, scope));
    };
    visit(sf, '<module>');
  }

  return {
    createTodoStaticKeys,
    createTodoHasBroad,
    todosKey,
    todoListCallsUseTodos,
    todoListJsxMountCount,
  };
}

// ── op-result shapes ─────────────────────────────────────────────────────────────────────────
interface Node {
  kind: string;
  label: string;
  key: string;
}
interface Hop {
  from: Node;
  to: Node;
  relation: string;
  confidence: string;
  provenance: { kind: string; by?: string };
  note?: string;
}
interface TraceData {
  found: number;
  moduleResolved: boolean;
  reRenderComponents: number;
  truncated: boolean;
  hops: Hop[];
}

function dataOf(r: OpResult): TraceData {
  assert.ok('result' in r, 'expected an op result, not a dispatch error');
  assert.ok(r.result.ok, 'op failed');
  return r.result.data as unknown as TraceData;
}

test('trace_invalidation: useCreateTodo → TodoList re-renders, oracle-confirmed, honest flags', async () => {
  const p = await projectFromDir('trace-invalidation');
  try {
    const facts = oracle(p.root);
    // The oracle independently sees the relations we are about to assert through the op.
    assert.deepEqual(
      facts.createTodoStaticKeys,
      [['todos']],
      'oracle: static invalidate ["todos"]',
    );
    assert.equal(facts.createTodoHasBroad, true, 'oracle: a broad invalidateQueries() exists');
    assert.deepEqual(facts.todosKey, ['todos'], 'oracle: useTodos keyed ["todos"]');
    assert.equal(facts.todoListCallsUseTodos, true, 'oracle: TodoList calls useTodos');
    assert.equal(facts.todoListJsxMountCount, 2, 'oracle: two <TodoList/> JSX mounts');

    const r = await p.op('trace_invalidation', { mutation: 'useCreateTodo' });
    const data = dataOf(r);
    assert.equal(data.moduleResolved, true);
    assert.equal(data.found, 1);

    const hops = data.hops;
    const rel = (name: string): Hop[] => hops.filter((h) => h.relation === name);

    // (1) invalidate edges: a CERTAIN static ['todos'] and a DYNAMIC broad — flagged, not bridged.
    const invalidates = rel('invalidates');
    const staticEdge = invalidates.find((h) => h.to.label === '["todos"]');
    assert.ok(staticEdge !== undefined, 'static ["todos"] invalidate hop present');
    assert.equal(staticEdge.confidence, 'certain', 'static invalidate is certain');
    assert.equal(staticEdge.provenance.by, 'react-query');
    const broadEdge = invalidates.find((h) => h.to.label === '(all)');
    assert.ok(broadEdge !== undefined, 'broad invalidate hop present');
    assert.equal(
      broadEdge.confidence,
      'dynamic',
      'broad invalidateQueries() must be flagged dynamic',
    );
    assert.match(broadEdge.note ?? '', /broad/);

    // (2) affects → useQuery(useTodos); (3) the useQuery is hosted in the hook useTodos.
    const affects = rel('affects');
    assert.ok(
      affects.some((h) => h.from.label === '["todos"]' && h.to.label === 'useQuery(useTodos)'),
      'static key affects the useTodos query',
    );

    // (4) THE #1 TRUST POINT: the subscriber re-renders via a `used-by` hop with TYPE provenance,
    // and it is TodoList — never App (the parent that only places <TodoList/>).
    const usedBy = rel('used-by');
    const toTodoList = usedBy.find((h) => h.to.label === 'TodoList');
    assert.ok(toTodoList !== undefined, 'hook useTodos → TodoList (used-by) present');
    assert.equal(toTodoList.from.label, 'useTodos');
    assert.equal(toTodoList.provenance.kind, 'type', 'used-by is LS-semantic (type) provenance');
    assert.equal(data.reRenderComponents, 1, 'exactly one re-rendering component (TodoList)');
    assert.ok(
      !usedBy.some((h) => h.to.label === 'App') && !hops.some((h) => h.to.label === 'App'),
      'App must NEVER be a re-rendering / used-by node — it only mounts <TodoList/>',
    );

    // (5) mounts: exactly two CERTAIN <TodoList/> sites (matching the oracle), plus one DYNAMIC
    // opaque value-read — flagged, never counted as a clean mount.
    const mounts = rel('mounted-at');
    const certainMounts = mounts.filter((h) => h.confidence === 'certain');
    const dynamicMounts = mounts.filter((h) => h.confidence === 'dynamic');
    assert.equal(
      certainMounts.length,
      facts.todoListJsxMountCount,
      'certain mounts equal the oracle JSX-tag count (2)',
    );
    assert.equal(
      dynamicMounts.length,
      1,
      'the opaque `= TodoList` read is one flagged-dynamic mount',
    );
    assert.equal(
      dynamicMounts[0]?.provenance.kind,
      'syntactic',
      'mounted-at is a syntactic JSX fact',
    );
    assert.match(dynamicMounts[0]?.note ?? '', /opaque/);
    for (const h of mounts) assert.equal(h.to.kind, 'mount', 'a mount target is a LOCATION leaf');

    // Proof spans validate against live source (no Loc↔offset drift).
    assert.ok(assertSpansValid(p.root, r) > 0, 'proof spans must validate against source');
  } finally {
    await p.dispose();
  }
});

test('trace_invalidation: an unknown mutation is honest (found:0), never a faked trace', async () => {
  const p = await projectFromDir('trace-invalidation');
  try {
    const data = dataOf(await p.op('trace_invalidation', { mutation: 'noSuchMutation' }));
    assert.equal(data.found, 0);
    assert.equal(data.reRenderComponents, 0);
    assert.deepEqual(data.hops, []);
  } finally {
    await p.dispose();
  }
});
