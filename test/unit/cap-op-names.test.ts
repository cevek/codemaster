// `capOpNames` is the §3.4 bound on a crash breadcrumb's `ops` list, shared by BOTH producers of
// that record (`mcp/inflight-ops.ts` and `daemon/daemon-server.ts` — L4 cannot import L5, which is
// why it lives in `common/`).
//
// It needs its own test because a shipped RECORD now makes a consumer-facing claim about its
// behaviour: `inflight.ts`'s crash prose and `entry.ts`'s `origin` doc both tell a log reader that
// beyond the cap the daemon's view carries a `+N more` marker the agent-facing record does not, so
// the correlation join is on a PREFIX. Change the cap or drop it on one side and that prose becomes
// a lie while every other test stays green.
//
// The oracle is the §3.4 rule itself, applied independently: a capped list must never be
// indistinguishable from a complete one, and an uncapped list must be byte-identical to its input.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { capOpNames, MAX_BREADCRUMB_OPS } from '../../src/common/truncate/cap-op-names.ts';

const names = (n: number): string[] => Array.from({ length: n }, (_, i) => `op${i}`);

test('at or under the cap the list passes through unchanged — no marker on an ordinary call', () => {
  for (const n of [0, 1, 5, MAX_BREADCRUMB_OPS]) {
    const input = names(n);
    assert.deepEqual(capOpNames(input, n), input, `${n} names must be untouched`);
  }
});

test('over the cap the list is truncated AND says so — never silently short (§3.4)', () => {
  const input = names(MAX_BREADCRUMB_OPS + 8);
  const out = capOpNames(input, input.length);
  assert.equal(out.length, MAX_BREADCRUMB_OPS + 1, 'kept names plus exactly one marker');
  assert.deepEqual(out.slice(0, MAX_BREADCRUMB_OPS), input.slice(0, MAX_BREADCRUMB_OPS));
  assert.equal(out[MAX_BREADCRUMB_OPS], '+8 more', 'the marker counts what was dropped');
  // The property that matters: a reader can always tell a capped list from a complete one.
  assert.notDeepEqual(out, input);
});

test('the marker counts the TOTAL, not how many names survived parsing', () => {
  // The agent-facing producer reads names out of raw envelopes; an unreadable one yields no name.
  // If the marker were driven by `names.length` a 40-request batch with unreadable envelopes would
  // report no truncation at all — the §3.4 lie this separate `total` parameter exists to prevent.
  const parsed = names(4);
  const out = capOpNames(parsed, 40, 4);
  assert.deepEqual(out, [...parsed, '+36 more']);

  // And with total at the cap, the same short list carries no marker.
  assert.deepEqual(capOpNames(parsed, 4, 4), parsed);
});

test('the shared cap is the one both breadcrumb producers use, so their lists cannot drift', async () => {
  // An independent check that the value the record's prose quotes ("beyond 32") is the value in
  // force — a bare re-declaration in either producer would break the shipped correlation advice.
  assert.equal(MAX_BREADCRUMB_OPS, 32);
  const { inflightOps } = await import('../../src/mcp/inflight-ops.ts');
  const requests = names(MAX_BREADCRUMB_OPS + 3).map((n) => ({ name: n, args: {} }));
  const out = inflightOps('batch', { requests });
  assert.equal(out.length, MAX_BREADCRUMB_OPS + 1);
  assert.equal(out[MAX_BREADCRUMB_OPS], '+3 more');
});
