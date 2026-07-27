// Unit-level coverage of the t-679091 guard branches the in-process differential fixture can't reach:
// process-mode NEVER refuses (it survives an OOM via the t-000052 kill/respawn mechanism), and an
// estimate failure falls through (the guard is an optimization, never an over-refusal). Params are
// narrowed to the two facts the check reads, so no OpContext/TsPluginApi faking is needed.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ok, fail } from '../../src/common/result/construct.ts';
import type { Result } from '../../src/core/result.ts';
import { semanticFanoutRefusal } from '../../src/ops/guard/semantic-fanout-guard.ts';
import type { IsolationReason } from '../../src/ops/registry.ts';

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

// t-754922: the refusal names the ONE cause that applies, so the agent gets one remedy instead of a
// menu it must diagnose itself (§3.6). Each cause must produce a DISTINCT, cause-specific sentence.
test('refusal names the actual cause — one remedy per cause, all distinct', () => {
  const msgFor = (reason: IsolationReason) =>
    semanticFanoutRefusal(
      { daemon: { isolation: 'in-process', isolationReason: reason } },
      ts(OVER),
      undefined,
    )?.message ?? '';

  assert.match(msgFor('auto-escalate-disabled'), /autoEscalate/);
  assert.match(msgFor('configured'), /codemaster\.config/);
  assert.match(msgFor('no-process-host'), /process-host factory/);
  assert.match(msgFor('within-budget'), /daemon restart/);
  assert.match(msgFor('estimate-failed'), /git listing failed/);

  const causes = [
    'auto-escalate-disabled',
    'configured',
    'no-process-host',
    'within-budget',
    'estimate-failed',
  ] as const;
  const messages = causes.map(msgFor);
  assert.equal(new Set(messages).size, causes.length, 'every cause yields its own remedy');
});

// Honest-on-unknown: no recorded cause must SAY so, never substitute a plausible one.
test('no recorded cause → says the cause is unknown, invents none', () => {
  const r = semanticFanoutRefusal({ daemon: { isolation: 'in-process' } }, ts(OVER), undefined);
  assert.ok(r !== undefined);
  assert.match(r.message, /not recorded/);
  assert.doesNotMatch(r.message, /autoEscalate: false|Auto-escalation is switched OFF/);
});

test('process-mode → NEVER refuses even far over threshold (survives the OOM via t-000052)', () => {
  const r = semanticFanoutRefusal({ daemon: { isolation: 'process' } }, ts(OVER), undefined);
  assert.equal(r, undefined, 'process-mode is a killable child — no refusal');
});

// t-693742: `force:true` USED to bypass this and killed the daemon in production — the tool's own
// refusal text advertised it as the escape. It must now refuse, and say the force was ignored.
test('force:true → still REFUSES in-process (no in-band route to a dead daemon)', () => {
  const r = semanticFanoutRefusal({ daemon: { isolation: 'in-process' } }, ts(OVER), true);
  assert.ok(r !== undefined, 'force must not override an uncatchable-OOM refusal');
  assert.match(r.message, /force:true.*does NOT override/i);
});

test('force:true under threshold → no refusal (force never manufactures one)', () => {
  const r = semanticFanoutRefusal({ daemon: { isolation: 'in-process' } }, ts(UNDER), true);
  assert.equal(r, undefined);
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
