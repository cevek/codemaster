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
  assert.deepEqual([...(data['available'] as string[])].sort(), ['keys', 'widgets']);
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
