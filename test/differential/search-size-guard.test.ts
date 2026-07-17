// t-333163 + t-399909 — the pre-warm PEAK size guard for the DEFAULT (navto) `search_symbol`. The
// real failure it prevents (an OOM warming a huge multi-program fan-out) can't be reproduced in a
// unit fixture, so these test the GATE behaviour + its no-warm discipline hermetically: a low
// `ts.searchWarmPeakMaxFiles` threshold over a small fixture drives every branch. The load-bearing
// assertion is that a refusal leaves the ts plugin COLD (fingerprint 'cold' via the orchestrator
// status) — proof the cheap estimate warmed nothing and built no program.
//
// t-399909 makes the guard PRUNING-AWARE: it gates on the POST-PRUNING PEAK (what will actually
// build) — `pruned ? primary.fileNames : Σ program.fileNames` — not the total surface. Two
// discriminating multi-program fixtures pin the two shapes the plain total-surface gate got wrong:
//   • LOOSE-ROOT — the primary subsumes the whole surface → the fan-out prunes to ONE program, so
//     the peak is the primary alone. The old total-surface gate over-refused it; here it WARMS.
//   • REFERENCES — the primary does NOT subsume → every program builds, so the peak is the SUMMED
//     file-set (overlapping globs make Σ > the union surface). The old surface gate UNDERcounted the
//     overlap and would have warmed into an OOM; here it REFUSES. The non-vacuous proof: the direct
//     `estimateSourceFileCount` (what the old gate used) is ≤ threshold while the peak is over it.
//
// The oracle is (a) the plugin's own `estimateSearchPeak` / `estimateSourceFileCount` numbers
// (independent structural facts read WITHOUT a warm) and (b) the plugin freshness fingerprint
// ('cold' iff no program was built) + the op result shape (refuse vs matches).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import path from 'node:path';
import { project } from '../helpers/project.ts';
import { createTsPlugin } from '../../src/plugins/ts/plugin.ts';

// A config with a peak threshold: written as a real codemaster.config.ts so the load → zod →
// plugin-construction wiring is exercised end-to-end (the guard is dead if any composition root
// drops the threshold).
const config = (peak: number): string =>
  `import { defineConfig } from 'codemaster';\n` +
  `export default defineConfig({ ts: { searchWarmPeakMaxFiles: ${peak} } });\n`;

// SINGLE-PROGRAM fixture: 4 source files (codemaster.config.ts counts too — the default tsconfig
// globs it). One program → the peak is the primary alone. Over 1, under 100, exactly 4 for boundary.
const FILES = (peak: number): Record<string, string> => ({
  'codemaster.config.ts': config(peak),
  'tsconfig.json': '{"compilerOptions":{"strict":true}}',
  'src/a.ts': 'export const Widget = 1;',
  'src/b.ts': 'export const Gadget = 2;',
  'src/c.ts': 'export const Gizmo = 3;',
});

// LOOSE-ROOT: the root tsconfig globs the WHOLE tree (`**/*.ts`, including the member's files), so
// the primary subsumes the surface → the fan-out prunes to the primary alone. A `pkg/` member
// (package.json anchor) makes it genuinely multi-program, so Σ > primary — the discriminator that
// the peak picks the primary, not the sum.
const LOOSE = (peak: number): Record<string, string> => ({
  'codemaster.config.ts': config(peak),
  'package.json': '{"name":"root","private":true}',
  'tsconfig.json': '{"compilerOptions":{"strict":true},"include":["**/*.ts"]}',
  'src/a.ts': 'export const Widget = 1;',
  'src/b.ts': 'export const Gadget = 2;',
  'pkg/package.json': '{"name":"pkg","private":true}',
  'pkg/tsconfig.json': '{"compilerOptions":{"strict":true},"include":["**/*.ts"]}',
  'pkg/c.ts': 'export const Cog = 3;',
  'pkg/d.ts': 'export const Dial = 4;',
});

// REFERENCES: the primary globs only `app/`, so it does NOT subsume the surface → no prune, every
// program builds. A root-adjacent `tsconfig.test.json` globs the SAME `app/` files (overlap) and a
// `pkg/` member adds more, so Σ program.fileNames EXCEEDS the union surface — the exact overlap the
// old total-surface gate undercounted into an OOM.
const REFS = (peak: number): Record<string, string> => ({
  'codemaster.config.ts': config(peak),
  'package.json': '{"name":"root","private":true}',
  'tsconfig.json': '{"compilerOptions":{"strict":true},"include":["app"]}',
  'tsconfig.test.json': '{"compilerOptions":{"strict":true},"include":["app"]}',
  'app/a.ts': 'export const Widget = 1;',
  'app/b.ts': 'export const Gadget = 2;',
  'pkg/package.json': '{"name":"pkg","private":true}',
  'pkg/tsconfig.json': '{"compilerOptions":{"strict":true},"include":["src"]}',
  'pkg/src/c.ts': 'export const Cog = 3;',
});

async function tsFingerprint(p: Awaited<ReturnType<typeof project>>): Promise<string | undefined> {
  const status = await p.orchestrator.status(p.root, p.root);
  return status.workspace?.plugins.find((x) => x.id === 'ts')?.fingerprint;
}

// Direct (no-warm) estimate oracle: build a plugin on the fixture root and read both numbers.
function estimates(root: string): {
  peak: { peakFiles: number; pruned: boolean };
  surface: number;
} {
  const ts = createTsPlugin(root);
  const peak = ts.estimateSearchPeak();
  const surface = ts.estimateSourceFileCount();
  assert.ok(peak.ok && surface.ok, 'estimates must succeed on a git fixture');
  return { peak: peak.data, surface: surface.data };
}

test('over threshold: default search_symbol REFUSES + redirects, and the LS stays COLD (no-warm)', async () => {
  const p = await project(FILES(1));
  try {
    const res = await p.op('search_symbol', { query: 'Widget' });
    assert.equal(
      'result' in res && res.result.ok,
      false,
      'the default path must refuse over threshold',
    );
    if ('result' in res && !res.result.ok) {
      assert.equal(res.result.failure.tool, 'size-guard', 'refusal is a size-guard ToolFailure');
      const msg = res.result.failure.message;
      assert.match(msg, /symbols_overview/, 'redirect names symbols_overview');
      assert.match(msg, /syntactic:true/, 'redirect names the syntactic escape');
      assert.match(msg, /force:true/, 'redirect names the force override');
      assert.match(msg, /\d+ files.*peak threshold 1/, 'refusal states the peak vs threshold');
    }
    assert.equal(await tsFingerprint(p), 'cold', 'a refused search must not warm the LS');
  } finally {
    await p.dispose();
  }
});

test('below threshold: the default path passes through and WARMS the LS (matches returned)', async () => {
  const p = await project(FILES(100));
  try {
    const res = await p.op('search_symbol', { query: 'Widget' });
    assert.ok('result' in res && res.result.ok, 'below threshold the default path answers');
    assert.notEqual(await tsFingerprint(p), 'cold', 'the default (navto) path warms the LS');
  } finally {
    await p.dispose();
  }
});

test('over threshold + syntactic:true is NOT gated (answers, stays cold)', async () => {
  const p = await project(FILES(1));
  try {
    const res = await p.op('search_symbol', { query: 'Widget', syntactic: true });
    assert.ok('result' in res && res.result.ok, 'the sanctioned no-warm escape is never gated');
    assert.equal(await tsFingerprint(p), 'cold', 'syntactic stays cold (the whole point)');
  } finally {
    await p.dispose();
  }
});

test('over threshold + force:true overrides the guard and WARMS the LS', async () => {
  const p = await project(FILES(1));
  try {
    const res = await p.op('search_symbol', { query: 'Widget', force: true });
    assert.ok('result' in res && res.result.ok, 'force:true bypasses the guard and answers');
    assert.notEqual(await tsFingerprint(p), 'cold', 'force:true warms the LS regardless of size');
  } finally {
    await p.dispose();
  }
});

test('peak == threshold passes (the guard is strictly OVER, not >=)', async () => {
  const p = await project(FILES(1)); // any threshold; we read the real peak first
  try {
    const { peak } = estimates(p.root);
    await p.dispose();
    const p2 = await project(FILES(peak.peakFiles)); // threshold == the exact peak
    try {
      const res = await p2.op('search_symbol', { query: 'Widget' });
      assert.ok('result' in res && res.result.ok, 'peak == threshold is not over — must answer');
      assert.notEqual(await tsFingerprint(p2), 'cold', 'a passing search warms the LS');
    } finally {
      await p2.dispose();
    }
  } finally {
    // p already disposed above on the happy path; guard against a throw before that.
  }
});

// t-399909 loose-root: the fan-out prunes to the primary, so the peak is the primary (< Σ). A
// threshold set BETWEEN the primary peak and Σ WARMS — proving the gate picks the pruned peak, not
// the sum. If the guard summed the fan-out it would refuse here.
test('LOOSE-ROOT: pruned peak = the primary (< Σ) → default search WARMS under a between-threshold', async () => {
  const probe = await project(LOOSE(1));
  const { peak, surface } = estimates(probe.root);
  await probe.dispose();
  assert.equal(peak.pruned, true, `loose-root must prune: ${JSON.stringify(peak)}`);
  // The discriminator: Σ (the un-pruned sum) strictly exceeds the pruned peak, so a between-threshold
  // separates "picks primary" (warm) from "picks Σ" (refuse). surface ≈ the primary here (loose root).
  const between = peak.peakFiles + 1; // > primary peak, and (by construction) < Σ
  assert.ok(surface >= peak.peakFiles - 1, 'surface tracks the primary on a loose root'); // sanity
  const p = await project(LOOSE(between));
  try {
    const res = await p.op('search_symbol', { query: 'Widget' });
    assert.ok(
      'result' in res && res.result.ok,
      `loose-root must warm (pruned peak): ${JSON.stringify(res)}`,
    );
    assert.notEqual(await tsFingerprint(p), 'cold', 'the pruned loose-root search warms the LS');
  } finally {
    await p.dispose();
  }
});

// t-399909 references: no prune, every program builds → peak = Σ program.fileNames, which (from the
// overlapping test config) EXCEEDS the union surface. The non-vacuous proof that this is a real
// regression fix: the surface count (what the old gate used) is ≤ threshold — the old gate would have
// WARMED into an OOM — while the Σ peak is over it, so the new gate REFUSES.
test('REFERENCES: no prune, Σ > surface → default search REFUSES where the old surface-gate would warm', async () => {
  const probe = await project(REFS(1));
  const { peak, surface } = estimates(probe.root);
  await probe.dispose();
  assert.equal(peak.pruned, false, `references must NOT prune: ${JSON.stringify(peak)}`);
  assert.ok(
    peak.peakFiles > surface,
    `Σ peak (${peak.peakFiles}) must exceed the union surface (${surface}) — the overlap the old gate undercounted`,
  );
  // A threshold at the surface count: the OLD total-surface gate (surface ≤ threshold) would WARM
  // (the OOM); the new Σ-peak gate (peak > threshold) REFUSES.
  const threshold = surface;
  const p = await project(REFS(threshold));
  try {
    const res = await p.op('search_symbol', { query: 'Widget' });
    assert.equal(
      'result' in res && res.result.ok,
      false,
      `references over-Σ must refuse: ${JSON.stringify(res)}`,
    );
    assert.equal(await tsFingerprint(p), 'cold', 'a refused references search warmed nothing');
  } finally {
    await p.dispose();
  }
});

// Estimate FAILURE (a git hiccup) must FALL THROUGH to warm, never over-refuse — the guard is an
// optimization, not a correctness gate. A MULTI-program fixture is required so the estimate actually
// consults git (the prune predicate's surface listing); removing `.git` then fails that listing →
// `estimate.ok` is false → the over-threshold branch is skipped → the default path warms.
test('estimate failure (broken git) falls THROUGH to warm, never over-refuses', async () => {
  const p = await project(LOOSE(1)); // threshold 1: a successful estimate WOULD refuse
  try {
    rmSync(path.join(p.root, '.git'), { recursive: true, force: true });
    const res = await p.op('search_symbol', { query: 'Widget' });
    assert.ok(
      'result' in res && res.result.ok,
      `a git-failed estimate must not refuse — it falls through to the real search: ${JSON.stringify(res)}`,
    );
    assert.notEqual(await tsFingerprint(p), 'cold', 'the fall-through path warms the LS');
  } finally {
    await p.dispose();
  }
});
