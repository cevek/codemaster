// Unit-level coverage of the t-679091 guard branches the in-process differential fixture can't reach:
// process-mode NEVER refuses (it survives an OOM via the t-000052 kill/respawn mechanism), and an
// estimate failure falls through (the guard is an optimization, never an over-refusal). Params are
// narrowed to the two facts the check reads, so no OpContext/TsPluginApi faking is needed.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ok, fail } from '../../src/common/result/construct.ts';
import type { Result } from '../../src/core/result.ts';
import { semanticFanoutRefusal } from '../../src/ops/guard/semantic-fanout-guard.ts';

const ts = (count: Result<number>, threshold = 4000) => ({
  estimateSourceFileCount: () => count,
  searchWarmMaxFiles: threshold,
});
const OVER = ok(5000);
const UNDER = ok(100);
const ESTIMATE_FAIL: Result<number> = fail({ tool: 'git', message: 'git failed' });

test('in-process, over threshold, no force → REFUSES with a process-mode redirect', () => {
  const r = semanticFanoutRefusal({ daemon: { isolation: 'in-process' } }, ts(OVER), undefined);
  assert.ok(r !== undefined, 'refuses');
  assert.match(r.message, /isolation/);
  assert.match(r.message, /5000 source files > threshold 4000/);
});

test('process-mode → NEVER refuses even far over threshold (survives the OOM via t-000052)', () => {
  const r = semanticFanoutRefusal({ daemon: { isolation: 'process' } }, ts(OVER), undefined);
  assert.equal(r, undefined, 'process-mode is a killable child — no refusal');
});

test('force:true → bypasses even in-process over threshold', () => {
  const r = semanticFanoutRefusal({ daemon: { isolation: 'in-process' } }, ts(OVER), true);
  assert.equal(r, undefined, 'force overrides');
});

test('under threshold → no refusal', () => {
  const r = semanticFanoutRefusal({ daemon: { isolation: 'in-process' } }, ts(UNDER), undefined);
  assert.equal(r, undefined, 'within budget warms normally');
});

test('estimate failure → falls through (never over-refuse; the guard is an optimization)', () => {
  const r = semanticFanoutRefusal(
    { daemon: { isolation: 'in-process' } },
    ts(ESTIMATE_FAIL),
    undefined,
  );
  assert.equal(r, undefined, 'a git hiccup must not refuse a legitimate op');
});

test('undefined daemon (no isolation wired) → no refusal (cannot confirm in-process risk)', () => {
  const r = semanticFanoutRefusal({ daemon: undefined }, ts(OVER), undefined);
  assert.equal(r, undefined, 'unknown isolation is treated as not-in-process — never over-refuse');
});
