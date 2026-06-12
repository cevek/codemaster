// Unit tests for common/ — pure logic, oracle = hand-computed ground truth.
// Includes the §16 invariant-7 DAG honesty check (cycles refused at init).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { RepoRelPath } from '../../src/core/brands.ts';
import { computeLineStarts, locToOffset, offsetToLoc } from '../../src/common/span/offset.ts';
import { extractText } from '../../src/common/span/extract-text.ts';
import { contains, intersects, equals } from '../../src/common/span/compare.ts';
import { compareFingerprints } from '../../src/common/fingerprint/compare.ts';
import { rollupFingerprint } from '../../src/common/fingerprint/rollup.ts';
import { parseDebugSpec } from '../../src/common/debug-spec/parse.ts';
import { LruMap } from '../../src/common/lru/map.ts';
import { topoSort } from '../../src/common/plugin-registry/toposort.ts';
import { createPluginRegistry } from '../../src/common/plugin-registry/create.ts';
import { encodeSymbolId, decodeSymbolId } from '../../src/common/ids/codec.ts';
import { worstOf } from '../../src/common/confidence/worst-of.ts';
import { ok, fail, partial } from '../../src/common/result/construct.ts';
import { isOk, isFailure } from '../../src/common/result/narrow.ts';
import { mergeFreshness } from '../../src/common/result/merge-freshness.ts';
import { combineFailures } from '../../src/common/result/combine-failures.ts';
import { withTimeout } from '../../src/common/async/with-timeout.ts';
import { debounce } from '../../src/common/async/debounce.ts';
import type { Clock } from '../../src/common/async/clock.ts';
import type { Plugin } from '../../src/core/plugin.ts';

const FILE = 'a.ts' as RepoRelPath;

test('span offset bridge: 1-based Loc ↔ 0-based offset round-trips (invariant 1 hotspot)', () => {
  const source = 'ab\ncd\n\nxyz';
  const starts = computeLineStarts(source);
  // Oracle: hand-computed offsets.
  assert.equal(locToOffset(starts, source.length, 1, 1), 0);
  assert.equal(locToOffset(starts, source.length, 2, 1), 3);
  assert.equal(locToOffset(starts, source.length, 4, 3), 9);
  assert.equal(locToOffset(starts, source.length, 5, 1), undefined); // out of range, not clamped
  for (let off = 0; off <= source.length; off++) {
    const loc = offsetToLoc(starts, source.length, off);
    assert.ok(loc !== undefined);
    assert.equal(locToOffset(starts, source.length, loc.line, loc.col), off);
  }
});

test('extractText returns the exact text or refuses', () => {
  const source = 'const x = 1;\nconst y = 2;\n';
  assert.equal(extractText(source, { line: 2, col: 7, endLine: 2, endCol: 8 }), 'y');
  assert.equal(extractText(source, { line: 9, col: 1, endLine: 9, endCol: 2 }), undefined);
});

test('span set-relations', () => {
  const span = (l: number, c: number, el: number, ec: number) => ({
    file: FILE,
    line: l,
    col: c,
    endLine: el,
    endCol: ec,
    text: '',
  });
  assert.ok(contains(span(1, 1, 5, 1), span(2, 1, 3, 1)));
  assert.ok(!contains(span(2, 1, 3, 1), span(1, 1, 5, 1)));
  assert.ok(intersects(span(1, 1, 2, 5), span(2, 3, 4, 1)));
  assert.ok(!intersects(span(1, 1, 2, 1), span(2, 1, 3, 1))); // touching ≠ intersecting
  assert.ok(equals(span(1, 2, 3, 4), span(1, 2, 3, 4)));
});

test('fingerprint compare: racy-clean mtime tie needs content (§19)', () => {
  const base = { path: FILE, size: 10, mtimeMs: 1000 };
  // Recorded long after mtime → equality is trustworthy.
  assert.equal(compareFingerprints({ ...base, recordedAtMs: 99999 }, base), 'same');
  // Recorded within the resolution window of its own mtime → tie, must hash.
  assert.equal(compareFingerprints({ ...base, recordedAtMs: 1001 }, base), 'tie');
  assert.equal(
    compareFingerprints({ ...base, recordedAtMs: 99999 }, { ...base, size: 11 }),
    'changed',
  );
  assert.equal(
    compareFingerprints({ ...base, recordedAtMs: 99999 }, { ...base, mtimeMs: 9000 }),
    'changed',
  );
  // Content hashes decide outright when both present.
  assert.equal(
    compareFingerprints({ ...base, contentHash: 'aa' }, { ...base, contentHash: 'aa' }),
    'same',
  );
});

test('rollup fingerprint is order-independent and content-sensitive', () => {
  const a = { path: 'a' as RepoRelPath, size: 1, mtimeMs: 1 };
  const b = { path: 'b' as RepoRelPath, size: 2, mtimeMs: 2 };
  assert.equal(rollupFingerprint([a, b]), rollupFingerprint([b, a]));
  assert.notEqual(rollupFingerprint([a, b]), rollupFingerprint([a, { ...b, size: 3 }]));
});

test('debug-spec matcher: wildcards and excludes', () => {
  const m = parseDebugSpec('plugin:ts:*,watcher,-eviction');
  assert.ok(m.enabled('plugin:ts:ls'));
  assert.ok(m.enabled('watcher'));
  assert.ok(!m.enabled('plugin:scss'));
  assert.ok(!m.enabled('eviction'));
  assert.ok(!parseDebugSpec('-noisy,*').enabled('noisy')); // exclude beats include
});

test('LruMap evicts least recently used', () => {
  const evicted: string[] = [];
  const lru = new LruMap<string, number>(2, (k) => evicted.push(k));
  lru.set('a', 1);
  lru.set('b', 2);
  lru.get('a'); // a is now most recent
  lru.set('c', 3);
  assert.deepEqual(evicted, ['b']);
  assert.deepEqual([...lru.keysByRecency()], ['a', 'c']);
});

test('topoSort orders deps first and reports the exact cycle', () => {
  const sorted = topoSort([
    { id: 'react-query', deps: ['ts'] },
    { id: 'ts', deps: [] },
  ]);
  assert.ok(sorted.ok);
  assert.ok(sorted.order.indexOf('ts') < sorted.order.indexOf('react-query'));

  const cyclic = topoSort([
    { id: 'a', deps: ['b'] },
    { id: 'b', deps: ['a'] },
  ]);
  assert.ok(!cyclic.ok && cyclic.reason === 'cycle');
  assert.deepEqual([...cyclic.cycle].sort(), ['a', 'a', 'b'].sort());
});

test('plugin DAG honesty (§16 invariant 7): registry refuses cycles at init', () => {
  const stub = (id: string, deps: string[]): Plugin => ({
    id,
    version: '0',
    deps,
    init: () => Promise.resolve(),
    dispose: () => Promise.resolve(),
    freshness: () => 'x',
    reindex: () => Promise.resolve(),
    pending: () => [],
  });
  const refused = createPluginRegistry([stub('a', ['b']), stub('b', ['a'])]);
  assert.ok(!refused.ok);
  assert.match(refused.message, /cycle/);

  const missing = createPluginRegistry([stub('a', ['ghost'])]);
  assert.ok(!missing.ok);
  assert.match(missing.message, /ghost/);
});

test('SymbolId codec routes by plugin prefix, payload stays opaque', () => {
  const id = encodeSymbolId('ts', 'Button@src/Button.tsx:v7');
  assert.deepEqual(decodeSymbolId(id), { plugin: 'ts', payload: 'Button@src/Button.tsx:v7' });
  assert.equal(decodeSymbolId('nocolon'), undefined);
  assert.equal(decodeSymbolId(':payload'), undefined);
});

test('confidence worstOf', () => {
  assert.equal(worstOf(['certain', 'partial', 'certain']), 'partial');
  assert.equal(worstOf(['dynamic', 'partial']), 'dynamic');
  assert.equal(worstOf(['certain', 'unresolved']), 'unresolved');
  assert.equal(worstOf([]), 'certain');
});

test('result constructors keep partiality explicit', () => {
  const okR = ok([1, 2]);
  assert.ok(isOk(okR));
  const failR = fail({ tool: 'git', message: 'boom' });
  assert.ok(isFailure(failR) && failR.failure.partial === false && failR.data === undefined);
  const partR = partial([1], { tool: 'git', message: 'died midway' });
  assert.ok(isFailure(partR) && partR.failure.partial === true && partR.data?.length === 1);
  const combined = combineFailures([failR.failure, partR.failure]);
  assert.ok(combined !== undefined && combined.partial === true && /boom/.test(combined.message));
});

test('mergeFreshness unions pending state, never drops it', () => {
  const merged = mergeFreshness([
    { plugins: [{ id: 'ts', fingerprint: 'v1' }], pending: 2, staleFiles: [FILE] },
    undefined,
    { plugins: [{ id: 'scss', fingerprint: 'v9' }], pending: 1 },
  ]);
  assert.ok(merged !== undefined);
  assert.equal(merged.pending, 3);
  assert.deepEqual(
    merged.plugins.map((p) => p.id),
    ['ts', 'scss'],
  );
  assert.deepEqual(merged.staleFiles, [FILE]);
});

function manualClock(): Clock & { advance(ms: number): void } {
  let now = 0;
  const timers: { at: number; fn: () => void }[] = [];
  return {
    now: () => now,
    schedule(ms, fn) {
      const timer = { at: now + ms, fn };
      timers.push(timer);
      return () => {
        const i = timers.indexOf(timer);
        if (i !== -1) timers.splice(i, 1);
      };
    },
    advance(ms) {
      now += ms;
      for (const t of [...timers].sort((a, b) => a.at - b.at)) {
        if (t.at <= now) {
          const i = timers.indexOf(t);
          if (i !== -1) timers.splice(i, 1);
          t.fn();
        }
      }
    },
  };
}

test('debounce + withTimeout drive off the injected clock — no sleeps (§16)', async () => {
  const clock = manualClock();
  const calls: number[][] = [];
  const d = debounce(clock, 100, (n: number) => calls.push([n]));
  d.trigger(1);
  d.trigger(2);
  clock.advance(99);
  assert.equal(calls.length, 0);
  clock.advance(1);
  assert.deepEqual(calls, [[2]]); // trailing edge, last args win

  const slow = new Promise<string>(() => undefined); // never resolves
  const racing = withTimeout(clock, 50, slow);
  clock.advance(50);
  assert.deepEqual(await racing, { timedOut: true });
  const fast = await withTimeout(clock, 50, Promise.resolve('v'));
  assert.deepEqual(fast, { timedOut: false, value: 'v' });
});
