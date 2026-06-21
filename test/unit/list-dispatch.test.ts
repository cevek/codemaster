// Unit: the GENERIC `list` op dispatcher (ops/list.ts), exercised over a FAKE registry-owning
// plugin — no `ts` plugin, no seam. Proves the discovery + routing contract that lets a framework
// plugin plug in WITHOUT editing the op: the op enumerates `listRegistries()` across the active
// plugins and routes `list {registry}` to the owner's `list()`. Oracle: the fake's known data.

import test from 'node:test';
import assert from 'node:assert/strict';
import { listOp } from '../../src/ops/list.ts';
import type { OpContext } from '../../src/ops/registry.ts';
import type { Plugin, PluginRegistry } from '../../src/core/plugin.ts';
import type { ListView } from '../../src/core/list.ts';
import type { Span } from '../../src/core/span.ts';
import { isOk } from '../../src/common/result/narrow.ts';
import { renderResult } from '../../src/format/render/render-result.ts';
import type { JsonValue } from '../../src/core/json.ts';

const span = (file: string): Span => ({
  file: file as Span['file'],
  line: 1,
  col: 1,
  endLine: 1,
  endCol: 5,
  text: 'X',
});

/** A minimal plugin exposing two registries, one with a composite-key entry (the queryKey shape). */
function fakePlugin(id: string, registries: Record<string, ListView>): Plugin {
  return {
    id,
    version: '0.0.0',
    deps: [],
    init: () => Promise.resolve(),
    dispose: () => Promise.resolve(),
    freshness: () => 'x',
    reindex: () => Promise.resolve(),
    pending: () => [],
    listRegistries: () => Object.keys(registries),
    list: (registry) => registries[registry] ?? { registry, entries: [] },
  };
}

/** A plugin that owns NO registries (the common case) — must not break discovery. */
const plainPlugin: Plugin = {
  id: 'plain',
  version: '0',
  deps: [],
  init: () => Promise.resolve(),
  dispose: () => Promise.resolve(),
  freshness: () => 'x',
  reindex: () => Promise.resolve(),
  pending: () => [],
};

function ctxOf(plugins: Plugin[]): OpContext {
  const byId = new Map(plugins.map((p) => [p.id, p]));
  const registry: PluginRegistry = {
    get: <T extends Plugin>(id: string): T => {
      const p = byId.get(id);
      if (p === undefined) throw new Error(`no plugin ${id}`);
      return p as T;
    },
    has: (id) => byId.has(id),
    ids: plugins.map((p) => p.id),
  };
  return { plugins: registry, flags: {} };
}

const demo = fakePlugin('demo', {
  widgets: {
    registry: 'widgets',
    note: 'a caveat',
    entries: [
      {
        name: 'Alpha',
        kind: 'widget',
        span: span('src/a.ts'),
        confidence: 'certain',
        provenance: { kind: 'heuristic', by: 'demo' },
      },
    ],
  },
  keys: {
    registry: 'keys',
    entries: [
      {
        segments: [{ value: 'todos', dynamic: false }, { dynamic: true }],
        kind: 'queryKey',
        span: span('src/b.ts'),
        confidence: 'dynamic',
        provenance: { kind: 'heuristic', by: 'demo' },
      },
    ],
  },
});

function dataOf(result: Awaited<ReturnType<typeof listOp.run>>): Record<string, JsonValue> {
  assert.ok(isOk(result), 'expected ok');
  return result.data as Record<string, JsonValue>;
}

test('routes to the owning plugin and projects entries + note', async () => {
  const data = dataOf(await listOp.run(ctxOf([plainPlugin, demo]), { registry: 'widgets' }));
  assert.equal(data['found'], true);
  assert.equal(data['owner'], 'demo');
  // `available` is the did-you-mean list for an UNKNOWN registry — omitted when found (it would
  // just restate `status`); the found:false tests below assert it IS present there.
  assert.equal(data['available'], undefined);
  assert.equal(data['note'], 'a caveat');
  const entries = data['entries'] as Array<Record<string, JsonValue>>;
  assert.equal(entries.length, 1);
  assert.equal(entries[0]?.['key'], 'Alpha');
  assert.equal(entries[0]?.['provenance'], 'heuristic:demo');
});

test('composite-key registry: segments preserved, dynamic segment shown <dyn>', async () => {
  const entries = dataOf(await listOp.run(ctxOf([demo]), { registry: 'keys' }))['entries'] as Array<
    Record<string, JsonValue>
  >;
  assert.equal(entries[0]?.['key'], '[todos, <dyn>]');
  assert.deepEqual(entries[0]?.['segments'], [
    { dynamic: false, value: 'todos' },
    { dynamic: true },
  ]);
});

test('unknown registry → honest available-list, found:false, never a guess', async () => {
  const data = dataOf(await listOp.run(ctxOf([demo]), { registry: 'nope' }));
  assert.equal(data['found'], false);
  assert.deepEqual([...(data['available'] as string[])].sort(), ['keys', 'widgets']);
  assert.deepEqual(data['entries'], []);
});

test('no registry-owning plugin active → empty available, found:false', async () => {
  const data = dataOf(await listOp.run(ctxOf([plainPlugin]), { registry: 'widgets' }));
  assert.equal(data['found'], false);
  assert.deepEqual(data['available'], []);
});

/** A registry of N entries all sharing one confidence (the ~100 dynamic-queryKeys shape). */
function uniformConfRegistry(
  conf: 'certain' | 'partial' | 'dynamic' | 'unresolved',
  n: number,
): ListView {
  return {
    registry: 'qk',
    entries: Array.from({ length: n }, (_, i) => ({
      name: `K${i}`,
      kind: 'queryKey',
      span: span(`src/q${i}.ts`),
      confidence: conf,
      provenance: { kind: 'heuristic' as const, by: 'demo' },
    })),
  };
}

test('#6 list: a uniform non-`certain` confidence is hoisted to allConfidence, dropped per row', async () => {
  const reg = fakePlugin('demo', { qk: uniformConfRegistry('unresolved', 3) });
  const result = await listOp.run(ctxOf([reg]), { registry: 'qk' });
  assert.ok(isOk(result));
  const data = result.data as Record<string, JsonValue>;
  assert.equal(data['allConfidence'], 'unresolved', 'hoisted to the header');
  const entries = data['entries'] as Array<Record<string, JsonValue>>;
  assert.ok(
    entries.every((e) => e['confidence'] === undefined),
    'confidence dropped from every row (sql refills via allConfidence)',
  );
  const out = renderResult(result, 'terse');
  assert.equal((out.match(/· unresolved/g) ?? []).length, 0, 'no per-row `· unresolved`');
  assert.match(out, /allConfidence=unresolved/, 'stated once in the header');
});

test('#6 list: a `certain` uniform is NOT hoisted (the tail is already invisible — no header noise)', async () => {
  const reg = fakePlugin('demo', { qk: uniformConfRegistry('certain', 3) });
  const result = await listOp.run(ctxOf([reg]), { registry: 'qk' });
  assert.ok(isOk(result));
  const data = result.data as Record<string, JsonValue>;
  assert.equal(data['allConfidence'], undefined, 'certain is not hoisted');
  assert.doesNotMatch(renderResult(result, 'terse'), /allConfidence/, 'no certain header noise');
});

test('#6 list: a MIXED confidence stays per-row (the variation is the signal)', async () => {
  const reg = fakePlugin('demo', {
    qk: {
      registry: 'qk',
      entries: [
        {
          name: 'A',
          kind: 'queryKey',
          span: span('src/a.ts'),
          confidence: 'certain',
          provenance: { kind: 'heuristic', by: 'demo' },
        },
        {
          name: 'B',
          kind: 'queryKey',
          span: span('src/b.ts'),
          confidence: 'unresolved',
          provenance: { kind: 'heuristic', by: 'demo' },
        },
      ],
    },
  });
  const result = await listOp.run(ctxOf([reg]), { registry: 'qk' });
  assert.ok(isOk(result));
  assert.equal(
    (result.data as Record<string, JsonValue>)['allConfidence'],
    undefined,
    'mixed → not hoisted',
  );
  assert.match(renderResult(result, 'terse'), /· unresolved/, 'the non-certain row keeps its tail');
});

/** A registry of N entries, each declared in `dir/eI.ts` — lets a path filter discriminate by dir. */
function dirRegistry(dirs: readonly string[]): ListView {
  return {
    registry: 'r',
    entries: dirs.map((dir, i) => ({
      name: `E${i}`,
      kind: 'widget',
      span: span(`${dir}/e${i}.ts`),
      confidence: 'certain' as const,
      provenance: { kind: 'heuristic' as const, by: 'demo' },
    })),
  };
}

test('limit caps the entry set and reports HONEST truncation {shown,total,hint} (not silent)', async () => {
  const full = dirRegistry(['src/a', 'src/a', 'src/a', 'src/a', 'src/a']); // oracle: 5 entries
  const reg = fakePlugin('demo', { r: full });
  // Oracle — no limit returns the full ground-truth set.
  const ground = dataOf(await listOp.run(ctxOf([reg]), { registry: 'r' }));
  assert.equal((ground['entries'] as unknown[]).length, 5);
  assert.equal(ground['truncated'], undefined);

  const result = await listOp.run(ctxOf([reg]), { registry: 'r', limit: 2 });
  assert.ok(isOk(result));
  const data = result.data as Record<string, JsonValue>;
  assert.equal((data['entries'] as unknown[]).length, 2, 'exactly limit shown');
  const t = result.truncated as { shown: number; total: number; hint: string } | undefined;
  assert.ok(t !== undefined, 'truncation present — never silent (§3.4)');
  assert.equal(t.shown, 2);
  assert.equal(t.total, 5, 'total = full ground-truth count');
  assert.match(t.hint, /limit/);
});

test('pathInclude keeps only matching-dir entries; excludedByFilter counts the dropped', async () => {
  const reg = fakePlugin('demo', { r: dirRegistry(['src/a', 'src/a', 'src/b', 'src/b', 'src/b']) });
  const data = dataOf(await listOp.run(ctxOf([reg]), { registry: 'r', pathInclude: ['src/a/**'] }));
  const entries = data['entries'] as Array<Record<string, JsonValue>>;
  assert.equal(entries.length, 2, 'only the 2 src/a entries');
  assert.ok(
    entries.every((e) => String(e['file']).startsWith('src/a/')),
    'every kept entry is under src/a',
  );
  assert.equal(data['excludedByFilter'], 3, 'the 3 src/b entries reported as excluded, not silent');
});

test('pathExclude drops matching-dir entries', async () => {
  const reg = fakePlugin('demo', { r: dirRegistry(['src/a', 'src/b', 'src/b']) });
  const data = dataOf(await listOp.run(ctxOf([reg]), { registry: 'r', pathExclude: ['src/b/**'] }));
  const entries = data['entries'] as Array<Record<string, JsonValue>>;
  assert.equal(entries.length, 1);
  assert.equal(entries[0]?.['file'], 'src/a/e0.ts');
  assert.equal(data['excludedByFilter'], 2);
});

test('sql-mode: the user limit is IGNORED — producer caps only at tableRowBound (§11)', async () => {
  const reg = fakePlugin('demo', { r: dirRegistry(['src/a', 'src/a', 'src/a', 'src/a', 'src/a']) });
  // tableRowBound (10) ABOVE the 5 entries: the user's limit:2 is ignored, all 5 flow uncapped.
  const ctx: OpContext = { ...ctxOf([reg]), tableRowBound: 10 };
  const result = await listOp.run(ctx, { registry: 'r', limit: 2 });
  assert.ok(isOk(result));
  const data = result.data as Record<string, JsonValue>;
  assert.equal((data['entries'] as unknown[]).length, 5, 'all 5 — user limit not applied in sql');
  assert.equal(result.truncated, undefined, 'no truncation — nothing was capped');
});

test('sql-mode: the engine bound (tableRowBound) IS honored and reported — never silently short (§11/§3.4)', async () => {
  const reg = fakePlugin('demo', { r: dirRegistry(['src/a', 'src/a', 'src/a', 'src/a', 'src/a']) });
  // tableRowBound (2) BELOW the 5 entries: the producer caps exactly where the engine would, and
  // MUST report truncation so the sql table is marked partial (a short NOT IN table lies).
  const ctx: OpContext = { ...ctxOf([reg]), tableRowBound: 2 };
  const result = await listOp.run(ctx, { registry: 'r' });
  assert.ok(isOk(result));
  const entries = (result.data as Record<string, JsonValue>)['entries'] as unknown[];
  assert.equal(entries.length, 2, 'capped at the engine bound');
  const t = result.truncated as { shown: number; total: number } | undefined;
  assert.ok(t !== undefined, 'engine-bound cap is reported, not silent');
  assert.equal(t.shown, 2);
  assert.equal(t.total, 5);
});

test('sql-mode: path filters STILL apply (an explicit WHERE, not a cap)', async () => {
  const reg = fakePlugin('demo', { r: dirRegistry(['src/a', 'src/a', 'src/b', 'src/b', 'src/b']) });
  const ctx: OpContext = { ...ctxOf([reg]), tableRowBound: 100 };
  const data = dataOf(await listOp.run(ctx, { registry: 'r', pathInclude: ['src/a/**'] }));
  const entries = data['entries'] as Array<Record<string, JsonValue>>;
  assert.equal(entries.length, 2, 'path filter applied in sql-mode');
  assert.ok(entries.every((e) => String(e['file']).startsWith('src/a/')));
  assert.equal(data['excludedByFilter'], 3);
});

test('empty pathInclude/pathExclude array is rejected by the schema (no silent drop-all)', () => {
  // An empty glob array matches nothing → matchesAnyGlob(f, []) === false → every entry dropped.
  // `.min(1)` fails this meaningless intent fast instead of returning an empty result as if real.
  assert.equal(listOp.argsSchema.safeParse({ registry: 'r', pathInclude: [] }).success, false);
  assert.equal(listOp.argsSchema.safeParse({ registry: 'r', pathExclude: [] }).success, false);
  // A non-empty array (and an omitted one) is accepted.
  assert.equal(
    listOp.argsSchema.safeParse({ registry: 'r', pathInclude: ['src/**'] }).success,
    true,
  );
  assert.equal(listOp.argsSchema.safeParse({ registry: 'r' }).success, true);
});

test('registry name collision across plugins → reported, first-wins, never silent', async () => {
  const other = fakePlugin('other', {
    widgets: { registry: 'widgets', entries: [] },
  });
  const data = dataOf(await listOp.run(ctxOf([demo, other]), { registry: 'widgets' }));
  assert.equal(data['owner'], 'demo'); // first-wins
  const conflicts = data['conflicts'] as string[];
  assert.equal(conflicts.length, 1);
  assert.match(conflicts[0] ?? '', /widgets.*demo.*other/);
});
