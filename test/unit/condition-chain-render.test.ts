// The ONE rendering of a `ConditionChain` (t-933867) — shared by the sql projection and the dense
// renderer, so its three outputs are a contract, not a formatting detail:
//   `a && !(b)`          a stated chain, outermost → innermost
//   the empty label      the MEASURED "no enclosing branch". Spelled `''` by default so the sql
//                        predicate `condition <> ''` works, and passed as a readable word by the
//                        dense face — BOTH spellings decided here, since an ABSENT chain (= "not
//                        annotated") is distinguished by field presence, never by this string.
//   leading `<unstated>` a branch above whose condition is not stated, or an annotation that could
//                        not be finished — the chain is a SUBSET (§3.4). A WORD, not `…`, because
//                        `…` already means "this predicate was cut" (trailing) and "extra
//                        destructured props" elsewhere; one glyph for three claims is unreadable.
// A silent drop of that marker would let a partial chain read as the whole guard set, which is the
// lie the annotation exists to prevent.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderConditionChain } from '../../src/common/condition/chain.ts';

test('renderConditionChain: stated chain, measured-empty, and the unstated-branch marker', () => {
  assert.equal(renderConditionChain({ conditions: ['a', '!(b)'] }), 'a && !(b)');
  assert.equal(renderConditionChain({ conditions: [] }), '', 'measured empty chain, sql spelling');
  assert.equal(
    renderConditionChain({ conditions: [] }, 'no branch'),
    'no branch',
    'measured empty chain, dense spelling — same renderer, caller-chosen token',
  );
  assert.equal(
    renderConditionChain({ conditions: ['a'], partial: true }),
    '<unstated> && a',
    'an unstated condition above is disclosed, not dropped',
  );
  assert.equal(
    renderConditionChain({ conditions: [], partial: true }),
    '<unstated>',
    'a site under ONLY an unstated branch is never rendered as the measured empty chain',
  );
  assert.equal(
    renderConditionChain({ conditions: [], partial: true }, 'no branch'),
    '<unstated>',
    'and the empty LABEL never wins over the subset marker — that would invert the claim',
  );
});
