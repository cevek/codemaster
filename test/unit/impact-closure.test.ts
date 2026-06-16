// The traversal invariants `impact` turns on, tested on a hand-built dependency graph —
// the graph IS the oracle (no LS here; the pure BFS is exercised against a fake `expand`).
// Covers: BFS shallowest-depth assignment, cycle termination (visited-set, NO hang), the
// global node cap, the depth cap, and value-flow boundary detection (gated on the parent
// being callable-natured, so a plain data read is NOT mis-flagged).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildClosure, type Expand } from '../../src/ops/impact-closure.ts';
import type { GroupRow } from '../../src/plugins/ts/query-types.ts';
import type { RepoRelPath } from '../../src/core/brands.ts';

function row(id: string, roles = 'call'): GroupRow {
  return {
    id,
    name: id,
    file: `${id}.ts` as RepoRelPath,
    line: 1,
    col: 1,
    kind: 'function',
    count: 1,
    roles,
    exported: true,
    confidence: 'certain',
  };
}

/** A fake `expand` over an adjacency map of `parentId -> dependent rows`. `callable` lists
 *  ids that are "callable-natured" (controls dynamic-boundary flagging); `deadEnds` lists
 *  ids whose re-query fails (ok:false) — a module rollup / unresolved id. */
function graphExpand(
  deps: Record<string, GroupRow[]>,
  callable: ReadonlySet<string> = new Set(),
  deadEnds: ReadonlySet<string> = new Set(),
): Expand {
  return (id) => {
    if (deadEnds.has(id)) return { ok: false };
    const enclosers = deps[id] ?? [];
    return {
      ok: true,
      enclosers,
      groupTotal: enclosers.length,
      callableNatured: callable.has(id),
    };
  };
}

const LIMITS = { maxDepth: 10, maxNodes: 100 };

test('BFS assigns each dependent its SHALLOWEST depth and terminates', () => {
  // seed → A → B; A also reached directly (depth 1) and via B-less path. Diamond: seed→A, seed→C, C→A.
  const deps: Record<string, GroupRow[]> = {
    seed: [row('A'), row('C')],
    A: [row('B')],
    C: [row('A')], // A also a dependent of C, but already at depth 1 — must NOT move to depth 2
    B: [],
  };
  const r = buildClosure({ id: 'seed', name: 'seed' }, graphExpand(deps), LIMITS);
  const byId = new Map(r.nodes.map((n) => [n.row.id, n.depth]));
  assert.equal(byId.get('A'), 1, 'A is depth 1 (shallowest), not 2 via C');
  assert.equal(byId.get('C'), 1);
  assert.equal(byId.get('B'), 2);
  assert.equal(r.nodes.length, 3, 'A counted once');
  assert.equal(r.capped, undefined, 'natural termination, no cap');
});

test('a cycle terminates via the visited-set (no hang, no duplicate)', () => {
  const deps: Record<string, GroupRow[]> = {
    seed: [row('A')],
    A: [row('B')],
    B: [row('A')], // A→B→A cycle; A already visited
  };
  const r = buildClosure({ id: 'seed', name: 'seed' }, graphExpand(deps), LIMITS);
  assert.deepEqual(
    r.nodes.map((n) => n.row.id).sort(),
    ['A', 'B'],
    'each node once; the cycle does not re-expand A',
  );
  assert.equal(r.capped, undefined);
});

test('a self-referential seed (recursion) never lists itself', () => {
  // seed's own decl rolls up to seed — primed into visited, so it is skipped.
  const deps: Record<string, GroupRow[]> = { seed: [row('seed'), row('A')], A: [] };
  const r = buildClosure({ id: 'seed', name: 'seed' }, graphExpand(deps), LIMITS);
  assert.deepEqual(
    r.nodes.map((n) => n.row.id),
    ['A'],
    'seed excludes itself',
  );
});

test('the global node cap stops the traversal and reports it INCOMPLETE', () => {
  const deps: Record<string, GroupRow[]> = {
    seed: [row('A'), row('B'), row('C'), row('D'), row('E')],
    A: [row('F'), row('G')],
    B: [],
    C: [],
    D: [],
    E: [],
  };
  const r = buildClosure({ id: 'seed', name: 'seed' }, graphExpand(deps), {
    maxDepth: 10,
    maxNodes: 3,
  });
  assert.equal(r.nodes.length, 3, 'never exceeds the node cap');
  assert.equal(r.capped?.by, 'nodes');
  assert.ok((r.capped?.boundaryNodes ?? 0) > 0, 'un-expanded boundary is counted');
});

test('the depth cap stops the traversal and counts the un-expanded boundary', () => {
  const deps: Record<string, GroupRow[]> = {
    seed: [row('A')],
    A: [row('B')],
    B: [row('C')],
    C: [],
  };
  const r = buildClosure({ id: 'seed', name: 'seed' }, graphExpand(deps), {
    maxDepth: 1,
    maxNodes: 100,
  });
  assert.deepEqual(
    r.nodes.map((n) => n.row.id),
    ['A'],
    'only depth 1',
  );
  assert.equal(r.capped?.by, 'depth');
  assert.equal(r.capped?.boundaryNodes, 1, 'A is the un-expanded boundary');
});

test('a value-only read of a CALLABLE parent is flagged a dynamic boundary; the node still expands', () => {
  const deps: Record<string, GroupRow[]> = {
    seed: [row('caller', 'call'), row('storer', 'read')], // storer reads seed as a value
    caller: [],
    storer: [row('deep', 'call')], // the value-read node is STILL expanded (over-report is safe)
  };
  const r = buildClosure(
    { id: 'seed', name: 'seed' },
    graphExpand(deps, new Set(['seed'])),
    LIMITS,
  );
  assert.equal(r.dynamicBoundaries.length, 1);
  assert.equal(r.dynamicBoundaries[0]?.encloser.id, 'storer');
  assert.equal(r.dynamicBoundaries[0]?.readsAsValue, 'seed');
  assert.ok(
    r.nodes.some((n) => n.row.id === 'deep'),
    'storer was still expanded — incoming role never gates expansion',
  );
});

test('a value read of a NON-callable parent (plain data const) is NOT flagged', () => {
  // `const MAX=5; f(){return MAX*2}` — MAX is read, never called → consumption, not dispatch.
  const deps: Record<string, GroupRow[]> = { seed: [row('f', 'read')], f: [] };
  const r = buildClosure({ id: 'seed', name: 'seed' }, graphExpand(deps, new Set()), LIMITS);
  assert.equal(r.dynamicBoundaries.length, 0, 'no over-flagging of a consumed data read');
});

test('a value/call dead-end (module rollup) is counted as unexpandable — closure incomplete', () => {
  // `mod` was reached by a `call` edge (e.g. `export const b = seed()`), then cannot be
  // re-expanded → its transitive dependents are a genuine gap.
  const deps: Record<string, GroupRow[]> = { seed: [row('mod', 'call')] };
  const r = buildClosure(
    { id: 'seed', name: 'seed' },
    graphExpand(deps, new Set(), new Set(['mod'])),
    LIMITS,
  );
  assert.equal(r.unexpandable, 1, 'the un-expandable value/call dead-end is counted');
});

test('a pure import/reexport dead-end is benign — NOT counted (the LS already followed it)', () => {
  const deps: Record<string, GroupRow[]> = { seed: [row('barrel', 'reexport')] };
  const r = buildClosure(
    { id: 'seed', name: 'seed' },
    graphExpand(deps, new Set(), new Set(['barrel'])),
    LIMITS,
  );
  assert.equal(r.unexpandable, 0, 're-export leaves do not inflate the incompleteness signal');
});
