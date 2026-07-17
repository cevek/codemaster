// Wall-clock deadline seam (t-000059) + its first two consumers (t-000030 impact,
// find_unused_exports). Two honesty properties, each with an independent oracle:
//
//   (a) NORMAL input + a generous budget → the op answers `ok` exactly as before (the deadline
//       never trips). Oracle: the same fixtures the impact/unused-exports suites pin, asserted
//       still-`ok` and complete — a regression here would flip a live op to a false timeout.
//   (b) An EXHAUSTED budget → the op degrades HONESTLY: `impact`/`find_unused_exports` return a
//       `ToolFailure{tool:'timeout', partial}` carrying the accumulated-so-far, never a complete
//       answer over a truncated walk (§3.4). Oracle: a hand-driven deadline (a counting stub for
//       the pure BFS; a `0`-budget engine for the end-to-end op) — deterministic under the frozen
//       manual clock, no sleep (§16).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { project } from '../helpers/project.ts';
import { manualClock } from '../helpers/project.ts';
import { createDeadline, NO_DEADLINE, type Deadline } from '../../src/common/async/deadline.ts';
import { buildClosure } from '../../src/ops/impact-closure.ts';
import type { GroupRow } from '../../src/plugins/ts/query-types.ts';
import type { RepoRelPath } from '../../src/core/brands.ts';
import type { OpResult } from '../../src/ops/contracts.ts';

// ── the seam: createDeadline over the injected Clock ──────────────────────────────────────────

test('createDeadline: expires exactly when the clock passes the budget; NO_DEADLINE never does', () => {
  const clock = manualClock();
  const d = createDeadline(clock, 100);
  assert.equal(d.expired(), false, 'fresh budget is live');
  assert.equal(d.remainingMs(), 100);
  clock.advance(99);
  assert.equal(d.expired(), false, '1 ms short — still live');
  assert.equal(d.remainingMs(), 1);
  clock.advance(1);
  assert.equal(d.expired(), true, 'at the budget — expired');
  assert.equal(d.remainingMs(), 0, 'remaining floors at 0, never negative');

  // A 0-budget is already expired (at == now) — the deterministic timeout-forcing lever.
  assert.equal(createDeadline(clock, 0).expired(), true);
  // The unbounded default never trips, whatever the clock does.
  clock.advance(1_000_000);
  assert.equal(NO_DEADLINE.expired(), false);
  assert.equal(NO_DEADLINE.remainingMs(), Infinity);
});

// ── impact's BFS: accumulate, then degrade to a timeout cap (pure, counting deadline) ──────────

function row(id: string, name: string): GroupRow {
  return {
    id,
    name,
    file: 'src/x.ts' as RepoRelPath,
    line: 1,
    col: 1,
    kind: 'const',
    count: 1,
    roles: 'call',
    exported: true,
    confidence: 'certain',
  };
}

test('buildClosure: a mid-walk timeout keeps the accumulated closure and caps `by: timeout`', () => {
  // The seed expands to three dependents at depth 1; each of those would expand again. A deadline
  // that goes live only on its SECOND poll lets the first `expand` (the seed) through, then trips
  // before any depth-2 expansion — so exactly the three depth-1 nodes are accumulated.
  let polls = 0;
  const deadline: Deadline = { expired: () => ++polls >= 2, remainingMs: () => 0 };
  const enclosers = [row('ts:a', 'a'), row('ts:b', 'b'), row('ts:c', 'c')];
  const expand = (id: string) =>
    id === 'ts:seed'
      ? { ok: true as const, enclosers, groupTotal: 3, callableNatured: false }
      : { ok: true as const, enclosers: [], groupTotal: 0, callableNatured: false };

  const closure = buildClosure(
    { id: 'ts:seed', name: 'seed' },
    expand,
    {
      maxDepth: 10,
      maxNodes: 100,
    },
    deadline,
  );

  assert.equal(closure.nodes.length, 3, 'the three depth-1 dependents survived as a real partial');
  assert.deepEqual(closure.nodes.map((n) => n.row.name).sort(), ['a', 'b', 'c']);
  assert.equal(closure.capped?.by, 'timeout', 'the walk stopped on the wall-clock budget');
  assert.ok((closure.capped?.boundaryNodes ?? 0) > 0, 'un-walked boundary reported, never hidden');
});

test('buildClosure: NO_DEADLINE (the default) walks the full closure — no false timeout', () => {
  const expand = (id: string) =>
    id === 'ts:seed'
      ? { ok: true as const, enclosers: [row('ts:a', 'a')], groupTotal: 1, callableNatured: false }
      : { ok: true as const, enclosers: [], groupTotal: 0, callableNatured: false };
  const closure = buildClosure({ id: 'ts:seed', name: 'seed' }, expand, {
    maxDepth: 10,
    maxNodes: 100,
  });
  assert.equal(closure.nodes.length, 1);
  assert.equal(closure.capped, undefined, 'no cap — a complete closure');
});

// ── end-to-end: impact + find_unused_exports through the real dispatch ─────────────────────────

const IMPACT_FIXTURE = {
  'tsconfig.json': '{"compilerOptions":{"strict":true}}',
  'src/core.ts': 'export const core = (n: number): number => n + 1;\n',
  'src/mid.ts':
    "import { core } from './core';\nexport const mid = (n: number): number => core(n) + 1;\n",
  'src/top.ts': "import { mid } from './mid';\nexport const top = (): number => mid(2);\n",
};

test('impact: generous budget answers `ok` and complete (no false timeout)', async () => {
  const p = await project(IMPACT_FIXTURE);
  try {
    const r = await p.op('impact', { name: 'core', depth: 3 });
    assert.ok('result' in r && r.result.ok, 'ok on a normal call');
    const data = r.result.data as { summary: { dependents: number; complete: boolean } };
    assert.equal(data.summary.complete, true);
    assert.equal(data.summary.dependents, 2, 'mid + top, the full closure');
  } finally {
    await p.dispose();
  }
});

test('impact: an exhausted budget returns a timeout partial, never a complete blast radius', async () => {
  const p = await project(IMPACT_FIXTURE, { opDeadlineMs: 0 });
  try {
    const r = await p.op('impact', { name: 'core', depth: 3 });
    assert.ok('result' in r, 'a result envelope, not a dispatch error');
    const res = r.result;
    assert.equal(res.ok, false, 'a failure envelope');
    assert.ok(!res.ok && res.failure.tool === 'timeout', 'tool=timeout');
    assert.ok(!res.ok && res.failure.partial === true, 'marked partial (never dressed complete)');
    // The seed resolved (find_usages is not budget-bound in Phase A), so the target + an INCOMPLETE
    // summary are carried — an agent sees the partial closure, flagged incomplete, not silence.
    const data = res.data as { summary?: { complete: boolean } } | undefined;
    assert.ok(data?.summary !== undefined, 'partial data carried');
    assert.equal(data.summary.complete, false, 'the truncated closure is NOT complete');
  } finally {
    await p.dispose();
  }
});

const UNUSED_FIXTURE = {
  'tsconfig.json': '{"compilerOptions":{"strict":true}}',
  'src/a.ts': 'export const usedByB = 1;\nexport const deadA = 2;\n',
  'src/b.ts': "import { usedByB } from './a';\nexport const deadB = usedByB + 1;\n",
};

function unusedNames(r: OpResult): string[] {
  assert.ok('result' in r && r.result.ok, JSON.stringify(r));
  const data = r.result.data as { unused: { name: string }[] };
  return data.unused.map((u) => u.name).sort();
}

test('find_unused_exports: generous budget answers `ok` with the real dead set', async () => {
  const p = await project(UNUSED_FIXTURE);
  try {
    const r = await p.op('find_unused_exports', {});
    assert.deepEqual(unusedNames(r), ['deadA', 'deadB'], 'the genuinely-dead exports');
  } finally {
    await p.dispose();
  }
});

test('find_unused_exports: an exhausted budget returns a timeout partial, not a false-clean list', async () => {
  const p = await project(UNUSED_FIXTURE, { opDeadlineMs: 0 });
  try {
    const r = await p.op('find_unused_exports', {});
    assert.ok('result' in r, 'a result envelope');
    const res = r.result;
    assert.equal(res.ok, false, 'a failure envelope — never `ok` with an empty (false-clean) list');
    assert.ok(!res.ok && res.failure.tool === 'timeout', 'tool=timeout');
    assert.ok(!res.ok && res.failure.partial === true, 'marked partial');
    // The scan is honest that it examined nothing: the empty `unused` is NOT proof of a clean repo.
    const data = res.data as { scanned: { exports: number } } | undefined;
    assert.equal(data?.scanned.exports, 0, 'examined 0 before the budget ran out');
  } finally {
    await p.dispose();
  }
});

// ── Phase B: the monolithic LS calls (find_usages / search_symbol) via the cancellation token ──

const FU_FIXTURE = {
  'tsconfig.json': '{"compilerOptions":{"strict":true}}',
  'src/def.ts': 'export const widget = 1;\n',
  'src/a.ts': "import { widget } from './def';\nexport const a = widget + 1;\n",
  'src/b.ts': "import { widget } from './def';\nexport const b = widget + 2;\n",
};

test('find_usages: generous budget answers `ok` with the real reference set', async () => {
  const p = await project(FU_FIXTURE);
  try {
    const r = await p.op('find_usages', { name: 'widget' });
    assert.ok('result' in r && r.result.ok, 'ok on a normal call');
    const data = r.result.data as { total: number };
    assert.ok(data.total >= 2, 'the widget references are found');
  } finally {
    await p.dispose();
  }
});

test('find_usages: an exhausted budget returns a TIMEOUT FAILURE, never an empty (0-usages) result', async () => {
  // The LS polls the cancellation token throughout findReferences; a 0 budget is already expired,
  // so the first poll cancels → OperationCanceledException → the op's timeout failure. Crucially
  // NOT a `partial` over an empty set — an empty findReferences dressed as data reads as "0 usages",
  // the exact completeness lie (§3.4). A monolithic call has no accumulated data to keep.
  const p = await project(FU_FIXTURE, { opDeadlineMs: 0 });
  try {
    const r = await p.op('find_usages', { name: 'widget' });
    assert.ok('result' in r, 'a result envelope, not a dispatch error');
    const res = r.result;
    assert.equal(res.ok, false, 'a failure envelope');
    assert.ok(!res.ok && res.failure.tool === 'timeout', 'tool=timeout');
    assert.ok(!res.ok && res.failure.partial !== true, 'NOT partial — no false empty-usages data');
    assert.ok(!res.ok && res.data === undefined, 'no data (empty ≠ 0 usages)');
  } finally {
    await p.dispose();
  }
});

test('search_symbol: generous budget finds the symbol; exhausted budget is a timeout failure', async () => {
  const ok = await project(FU_FIXTURE);
  try {
    const r = await ok.op('search_symbol', { query: 'widget' });
    assert.ok('result' in r && r.result.ok, 'ok on a normal navto');
    const data = r.result.data as { matches: unknown[] };
    assert.ok(data.matches.length >= 1, 'widget is found');
  } finally {
    await ok.dispose();
  }
  const timed = await project(FU_FIXTURE, { opDeadlineMs: 0 });
  try {
    const r = await timed.op('search_symbol', { query: 'widget' });
    assert.ok('result' in r, 'a result envelope');
    const res = r.result;
    assert.equal(res.ok, false, 'a failure envelope — never an empty match list dressed as clean');
    assert.ok(!res.ok && res.failure.tool === 'timeout', 'tool=timeout');
  } finally {
    await timed.dispose();
  }
});
