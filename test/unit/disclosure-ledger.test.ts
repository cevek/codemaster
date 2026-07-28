// The disclosure ledger's own contract (§3.4), independent of any op: isolation between scopes,
// re-entrancy, and the no-op-outside-a-scope rule. These are the properties the envelope channel
// rests on, and two of them have no other coverage — the differential suite exercises the ledger
// only through ops, which today never nest.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { disclose, runWithDisclosures } from '../../src/support/disclosure/ledger.ts';
import { ok } from '../../src/common/result/construct.ts';
import type { Disclosure } from '../../src/core/result.ts';

const CLAIM: Disclosure = {
  unsafe: 'target-is-the-only-symbol-of-this-name',
  target: "name 'X'",
  note: 'n',
};

test('a scope that disclosed nothing returns a byte-identical envelope', async () => {
  const envelope = ok({ v: 1 });
  const out = await runWithDisclosures(() => Promise.resolve(envelope));
  assert.equal(out, envelope, 'no disclosure must mean no new object and no empty array');
  assert.equal(out.disclosures, undefined);
});

test('disclosing outside a scope is a no-op, never a throw', () => {
  assert.doesNotThrow(() => disclose(CLAIM));
});

test('concurrent scopes do not bleed into each other', async () => {
  // The failure this pins is the whole reason the ledger is async-context-scoped rather than a
  // module global: two engines' ops interleave in one process, and one repo's doubt landing on
  // another repo's answer is false incompleteness manufactured by the mechanism itself.
  const slow = runWithDisclosures(async () => {
    disclose(CLAIM);
    await Promise.resolve();
    return ok({ which: 'slow' });
  });
  const fast = runWithDisclosures(() => Promise.resolve(ok({ which: 'fast' })));
  const [a, b] = await Promise.all([slow, fast]);
  assert.deepEqual(a.disclosures, [CLAIM]);
  assert.equal(b.disclosures, undefined, 'the neighbouring scope must stay clean');
});

test('a nested scope joins the outer one, so an inner claim reaches the outer envelope', async () => {
  // Nothing nests today; the branch exists so that when something does, an inner resolution's claim
  // travels OUT to the answer the agent reads instead of being stamped on an intermediate result
  // nobody sees — a silent drop of the channel.
  const outer = await runWithDisclosures(async () => {
    const inner = await runWithDisclosures(() => {
      disclose(CLAIM);
      return Promise.resolve(ok({ v: 'inner' }));
    });
    assert.deepEqual(inner.disclosures, [CLAIM], 'the inner envelope still states it');
    return ok({ v: 'outer' });
  });
  assert.deepEqual(outer.disclosures, [CLAIM], 'and the outer envelope inherits it');
});

test('one claim raised twice is stated once', async () => {
  const out = await runWithDisclosures(() => {
    disclose(CLAIM);
    disclose({ ...CLAIM });
    disclose({ ...CLAIM, target: "name 'Y'" });
    return Promise.resolve(ok({ v: 1 }));
  });
  assert.equal(out.disclosures?.length, 2, 'deduped by claim+target, not by object identity');
});
