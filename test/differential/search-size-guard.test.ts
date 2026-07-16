// t-333163 — the pre-warm size guard for the DEFAULT (navto) `search_symbol`. The real failure it
// prevents (an OOM warming a huge multi-program fan-out) can't be reproduced in a unit fixture, so
// these test the GATE behaviour + its no-warm discipline hermetically: a low `ts.searchWarmMaxFiles`
// threshold over a small fixture drives every branch. The load-bearing assertion is that a refusal
// leaves the ts plugin COLD (fingerprint 'cold' via the orchestrator status) — proof the cheap
// estimate warmed nothing and built no program, exactly the property the guard exists to protect.
//
// The oracle is the plugin freshness fingerprint itself (an independent structural fact: 'cold' iff
// no program was built), plus the op result shape (refuse vs matches). Discriminating: the below-
// threshold / syntactic / force branches each WARM-or-answer where the refuse branch does not.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import path from 'node:path';
import { project } from '../helpers/project.ts';

// A config with a threshold of 1: any fixture with >1 source file exceeds it, so the default path
// refuses. Written as a real codemaster.config.ts so the load → zod → plugin-construction wiring is
// exercised end-to-end (the guard is dead if any composition root drops the threshold).
const config = (max: number): string =>
  `import { defineConfig } from 'codemaster';\n` +
  `export default defineConfig({ ts: { searchWarmMaxFiles: ${max} } });\n`;

// FOUR source files (codemaster.config.ts counts too — the estimate is a superset of navto's actual
// program fan-out, conservative-by-design: over-count favours refusing). Over a threshold of 1, under
// a threshold of 100, and exactly 4 for the boundary case.
const FILES = (max: number): Record<string, string> => ({
  'codemaster.config.ts': config(max),
  'tsconfig.json': '{"compilerOptions":{"strict":true}}',
  'src/a.ts': 'export const Widget = 1;',
  'src/b.ts': 'export const Gadget = 2;',
  'src/c.ts': 'export const Gizmo = 3;',
});

async function tsFingerprint(p: Awaited<ReturnType<typeof project>>): Promise<string | undefined> {
  const status = await p.orchestrator.status(p.root, p.root);
  return status.workspace?.plugins.find((x) => x.id === 'ts')?.fingerprint;
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
      assert.match(
        msg,
        /\d+ source files > threshold 1/,
        'refusal states the measured count vs threshold',
      );
    }

    // The load-bearing discriminant: the estimate warmed nothing → no program was built → the ts
    // plugin fingerprint is still 'cold'. A warm would flip it to `v<n>`.
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
    assert.equal(
      await tsFingerprint(p),
      'cold',
      'syntactic stays cold (the whole point of the escape)',
    );
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

// Boundary: count EQUAL to the threshold is NOT "over" (`>` semantics — equal passes). The fixture is
// exactly 4 source files, so threshold 4 must pass, not refuse. Discriminates `>` from `>=`.
test('count == threshold passes (the guard is strictly OVER, not >=)', async () => {
  const p = await project(FILES(4));
  try {
    const res = await p.op('search_symbol', { query: 'Widget' });
    assert.ok('result' in res && res.result.ok, 'count == threshold is not over — must answer');
    assert.notEqual(await tsFingerprint(p), 'cold', 'a passing search warms the LS');
  } finally {
    await p.dispose();
  }
});

// Estimate FAILURE (a git hiccup) must FALL THROUGH to warm, never over-refuse a legitimate search —
// the guard is an optimization, not a correctness gate (op comment + api.ts both promise this). We
// break the estimate by removing `.git` after setup: `gitSourceFilesSync` then fails → `estimate.ok`
// is false → the over-threshold condition is skipped → the default path warms. Without this test, an
// inverted guard (`!estimate.ok || …`) that over-refuses on a git error stays green.
test('estimate failure (broken git) falls THROUGH to warm, never over-refuses', async () => {
  const p = await project(FILES(1)); // threshold 1: if the estimate SUCCEEDED it would refuse
  try {
    rmSync(path.join(p.root, '.git'), { recursive: true, force: true });
    const res = await p.op('search_symbol', { query: 'Widget' });
    assert.ok(
      'result' in res && res.result.ok,
      'a git-failed estimate must not refuse — it falls through to the real search',
    );
    assert.notEqual(await tsFingerprint(p), 'cold', 'the fall-through path warms the LS');
  } finally {
    await p.dispose();
  }
});
