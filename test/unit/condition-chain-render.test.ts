// The ONE rendering of a `ConditionChain` (t-933867) — shared by the sql projection and the dense
// renderer, so its three outputs are a contract, not a formatting detail:
//   `a && !(b)`  a stated chain, outermost → innermost
//   `''`         the MEASURED "no enclosing branch" (an ABSENT chain means "not annotated" — the
//                caller distinguishes the two by presence, never by this string)
//   leading `…`  a real branch above whose condition is not stated — the chain is a SUBSET (§3.4)
// A silent drop of that marker would let a partial chain read as the whole guard set, which is the
// lie the annotation exists to prevent.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderConditionChain } from '../../src/common/condition/chain.ts';

test('renderConditionChain: stated chain, measured-empty, and the unstated-branch marker', () => {
  assert.equal(renderConditionChain({ conditions: ['a', '!(b)'] }), 'a && !(b)');
  assert.equal(renderConditionChain({ conditions: [] }), '', 'measured empty chain');
  assert.equal(
    renderConditionChain({ conditions: ['a'], partial: true }),
    '… && a',
    'an unstated condition above is disclosed, not dropped',
  );
  assert.equal(
    renderConditionChain({ conditions: [], partial: true }),
    '…',
    'a site under ONLY an unstated branch is never rendered as the measured empty chain',
  );
});
