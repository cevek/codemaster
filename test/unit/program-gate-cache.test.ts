// The write gate's caches (program-gate-cache.ts): a cached baseline / reused gate result must be
// indistinguishable from computing it now. Stub programs make the LS a counted, scriptable oracle:
// each file's content is `ERR:<msg>,…` (or anything else = clean), read from the overlay when one
// is set, else from the stub "disk". The oracle for every verdict is the SAME gate run uncached.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'node:path';
import type ts from 'typescript';
import type { RepoRelPath } from '../../src/core/brands.ts';
import type { OverlayEntry } from '../../src/plugins/ts/vfs/overlay.ts';
import type { SingleProgram } from '../../src/plugins/ts/program/single.ts';
import { gateAcross, type GateHostCtx, type GateScope } from '../../src/plugins/ts/program-gate.ts';
import { createGateCache } from '../../src/plugins/ts/program-gate-cache.ts';

interface Stub {
  program: SingleProgram;
  disk: Map<string, string>;
  calls: { disk: number; overlay: number };
  bumpDisk(): void;
  throwOnce: Set<string>;
  outerOverlay: { on: boolean };
}

function stub(label: string, disk: Record<string, string>, opts: { throws?: boolean } = {}): Stub {
  const files = new Map(Object.entries(disk));
  let overlay: Map<string, string> | undefined;
  let diskVersion = 1;
  const calls = { disk: 0, overlay: 0 };
  const throwOnce = new Set<string>();
  const outerOverlay = { on: false };
  const contentOf = (abs: string) => (overlay?.get(abs) ?? files.get(abs)) as string;
  const service = {
    getProgram: () =>
      ({
        getSourceFile: (abs: string) => (overlay?.has(abs) || files.has(abs) ? {} : undefined),
      }) as unknown as ts.Program,
    getSyntacticDiagnostics: () => [],
    getSemanticDiagnostics: (abs: string) => {
      if (overlay !== undefined) calls.overlay++;
      else calls.disk++;
      if (opts.throws === true) throw new Error(`${label} LS exploded`);
      if (throwOnce.delete(abs)) throw new Error('cancelled');
      const c = contentOf(abs);
      if (!c.startsWith('ERR:')) return [];
      return c
        .slice(4)
        .split(',')
        .map((m) => ({ messageText: m }) as unknown as ts.Diagnostic);
    },
  } as unknown as ts.LanguageService;
  const program = {
    service,
    label,
    configPath: undefined,
    containsFile: () => true,
    mayContain: () => false,
    diskVersion: () => diskVersion,
    overlayActive: () => outerOverlay.on || overlay !== undefined,
    setOverlay: (entries: readonly OverlayEntry[]) => {
      overlay = new Map(entries.map((e) => [e.abs, e.content]));
    },
    clearOverlay: () => {
      overlay = undefined;
    },
  } as unknown as SingleProgram;
  return {
    program,
    disk: files,
    calls,
    bumpDisk: () => diskVersion++,
    throwOnce,
    outerOverlay,
  };
}

const ROOT = '/root';
const abs = (rel: string) => `${ROOT}/${rel}`;

function ctxOf(cache: ReturnType<typeof createGateCache> | undefined, ...ps: Stub[]): GateHostCtx {
  const [first] = ps;
  if (first === undefined) throw new Error('need a program');
  return {
    primary: first.program,
    programs: ps.map((p) => p.program),
    relOf: (a) => path.relative(ROOT, a) as RepoRelPath,
    absOf: (rel) => path.join(ROOT, rel),
    ...(cache !== undefined ? { cache } : {}),
  };
}

const rel = (s: string) => s as RepoRelPath;
const SCOPE: GateScope = { anchor: [rel('a.ts')], check: [rel('a.ts'), rel('b.ts')] };
const edit = (content: string) => [{ path: rel('a.ts'), content }];
const total = (s: Stub) => s.calls.disk + s.calls.overlay;
const reset = (s: Stub) => {
  s.calls.disk = 0;
  s.calls.overlay = 0;
};
const DISK = { [abs('a.ts')]: 'ok', [abs('b.ts')]: 'ERR:pre' };

test('an identical second gate is served whole; a different edit reuses only the baseline', () => {
  const p = stub('tsconfig.json', DISK);
  const ctx = ctxOf(createGateCache(), p);
  const first = gateAcross(ctx, edit('ERR:new'), SCOPE);
  const cold = (files: ReturnType<typeof edit>) =>
    gateAcross(ctxOf(undefined, stub('tsconfig.json', DISK)), files, SCOPE);
  assert.deepEqual(first, cold(edit('ERR:new')));

  reset(p);
  assert.deepEqual(gateAcross(ctx, edit('ERR:new'), SCOPE), first);
  assert.equal(total(p), 0, 'identical inputs + unchanged disk → no LS call at all');

  reset(p);
  const second = gateAcross(ctx, edit('clean'), SCOPE);
  assert.equal(p.calls.disk, 0, 'baseline came from the cache');
  assert.ok(p.calls.overlay > 0, 'the new edit was typechecked');
  assert.deepEqual(second, cold(edit('clean')));
});

test('every component of the gate-result key forces a recompute when it changes', () => {
  const variants: [
    string,
    (
      p: Stub,
      other: Stub,
    ) => { ctx?: GateHostCtx; files?: ReturnType<typeof edit>; scope?: GateScope },
  ][] = [
    ['content', () => ({ files: edit('ERR:other') })],
    ['removed', () => ({ scope: { ...SCOPE, removed: [rel('b.ts')] } })],
    ['check', () => ({ scope: { ...SCOPE, check: [rel('a.ts')] } })],
    ['diskVersion', (p) => (p.bumpDisk(), {})],
    ['program identity', (_p, other) => ({ ctx: ctxOf(undefined, other) })],
  ];
  for (const [name, change] of variants) {
    const p = stub('tsconfig.json', DISK);
    const other = stub('tsconfig.json', DISK);
    const cache = createGateCache();
    gateAcross(ctxOf(cache, p), edit('ERR:new'), SCOPE);
    reset(p);
    const v = change(p, other);
    const ctx = v.ctx !== undefined ? { ...v.ctx, cache } : ctxOf(cache, p);
    gateAcross(ctx, v.files ?? edit('ERR:new'), v.scope ?? SCOPE);
    const used = v.ctx !== undefined ? other : p;
    assert.ok(used.calls.overlay > 0, `changing ${name} must not serve the previous gate result`);
  }
});

test('a disk-version bump drops the cached baseline', () => {
  const p = stub('tsconfig.json', DISK);
  const ctx = ctxOf(createGateCache(), p);
  gateAcross(ctx, edit('clean'), SCOPE);
  // The disk LOSES an error: a stale baseline would still hold it and could absorb an introduced one.
  p.disk.set(abs('b.ts'), 'clean');
  p.bumpDisk();
  const g = gateAcross(ctx, edit('ok'), SCOPE);
  assert.deepEqual(g.baseline, [], 'baseline reflects the reindexed disk');
});

test('a collection interrupted mid-file never stores that file', () => {
  // a.ts carries a disk error AND is the edited file: its overlay is clean, so nothing downstream
  // would reveal an empty entry stored for it — only the store rule keeps the baseline right.
  const disk = { [abs('a.ts')]: 'ERR:pre', [abs('b.ts')]: 'ok' };
  const p = stub('tsconfig.json', disk);
  const ctx = ctxOf(createGateCache(), p);
  p.throwOnce.add(abs('a.ts'));
  assert.throws(() => gateAcross(ctx, edit('clean'), SCOPE), /cancelled/);
  const g = gateAcross(ctx, edit('clean'), SCOPE);
  assert.deepEqual(
    g,
    gateAcross(ctxOf(undefined, stub('tsconfig.json', disk)), edit('clean'), SCOPE),
    'a.ts recomputed, not cached empty',
  );
});

test('a gate entered under an already-applied overlay neither reads nor writes the cache', () => {
  const p = stub('tsconfig.json', DISK);
  const ctx = ctxOf(createGateCache(), p);
  p.outerOverlay.on = true;
  gateAcross(ctx, edit('clean'), SCOPE);
  p.outerOverlay.on = false;
  reset(p);
  gateAcross(ctx, edit('clean'), SCOPE);
  assert.ok(p.calls.disk > 0, 'the overlay-time baseline was not reused as a disk baseline');
});

test('a gate with a degraded sibling is not reused', () => {
  const p = stub('tsconfig.json', DISK);
  const broken = stub('tsconfig.broken.json', DISK, { throws: true });
  const ctx = ctxOf(createGateCache(), p, broken);
  gateAcross(ctx, edit('clean'), SCOPE);
  reset(p);
  const g = gateAcross(ctx, edit('clean'), SCOPE);
  assert.ok(p.calls.overlay > 0, 'recomputed rather than served');
  assert.equal(g.degraded.length, 1);
});

test('a stale cached baseline is re-derived before it can cause a refusal', () => {
  const p = stub('tsconfig.json', DISK);
  const ctx = ctxOf(createGateCache(), p);
  gateAcross(ctx, edit('clean'), SCOPE);
  // The disk view changes with no disk-version bump (a resolution re-run for a file reverted from
  // an overlay, t-828499): the overlay pass sees it, the cached baseline does not.
  p.disk.set(abs('b.ts'), 'ERR:pre,unseen');
  const g = gateAcross(ctx, edit('ok'), SCOPE);
  assert.ok(
    g.baseline.some((d) => d.message === 'unseen'),
    'baseline re-derived from disk, so the unseen error is not reported as introduced',
  );
});
