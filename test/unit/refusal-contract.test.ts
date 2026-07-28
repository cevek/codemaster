// t-615758 / t-166631 — the refusal CONTRACT, as opposed to the prose it renders.
//
// Two failures that read alike leave the caller in different positions: one declined before doing
// any work (the engine is intact — a program-building call still runs here), the other died doing
// it (no program build is within reach, whatever the target). Conflating them once printed the
// caller the exact call that had just OOM'd. The distinction is therefore a field on `ToolFailure`,
// and these tests assert the two properties a field buys over prose:
//
//   1. every navigational refusal STATES its claim (`outOfReach`), and
//   2. the redirect it renders AGREES with that claim — because it is derived from it, not held
//      beside it.
//
// The oracle for (2) is `CheapCall.buildsProgram`, which is a property of the named call itself
// (does running it build a TS program), independent of the claim being checked. Both assertions
// fail against the pre-t-615758 tree: there is no field to read.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ok } from '../../src/common/result/construct.ts';
import type { OutOfReach, Result, ToolFailure } from '../../src/core/result.ts';
import { cheapCallsFor } from '../../src/ops/guard/navigate.ts';
import { opRefusal, wireRefusal } from '../../src/ops/guard/refusal.ts';
import { semanticFanoutRefusal } from '../../src/ops/guard/semantic-fanout-guard.ts';

const OVER: Result<number> = ok(5000);
const ts = { estimateSourceFileCount: () => OVER, searchWarmMaxFiles: 4000 };

/** Every claim there is. Written so a member ADDED to the union is a compile error here rather than
 *  a silent hole — the failure mode this file exists to catch is precisely a claim nobody checks. */
const EVERY_CLAIM = ['this-call', 'any-program-build', 'unproven-program-build'] as const;
const _exhaustive: readonly OutOfReach[] = EVERY_CLAIM satisfies readonly OutOfReach[];
type _Covered = Exclude<OutOfReach, (typeof EVERY_CLAIM)[number]> extends never ? true : never;
const _covered: _Covered = true;

/** Does this message name a call that would build a TS program? Answered from the table's own
 *  per-call `buildsProgram` under EVERY claim, so the check never re-derives what it is verifying
 *  and cannot miss a candidate that only one claim would have surfaced. */
function namesAProgramBuild(op: string, args: unknown, message: string): boolean {
  return EVERY_CLAIM.flatMap((r) => cheapCallsFor(op, args, r).calls).some(
    (c) => c.buildsProgram === true && message.includes(c.call),
  );
}

/** The invariant every producer must satisfy. Stated NEGATIVELY — a program build may be named only
 *  under the one claim that licenses it — because that form is exhaustive by construction: a claim
 *  added to the union inherits the conservative check instead of falling out of coverage, which is
 *  how `'unproven-program-build'` would otherwise have arrived unchecked. */
function assertAgrees(f: ToolFailure, op: string, args: unknown): void {
  assert.ok(f.outOfReach !== undefined, `${op}: a navigational refusal must state its claim`);
  if (f.outOfReach !== 'this-call') {
    assert.equal(
      namesAProgramBuild(op, args, f.message),
      false,
      `${op}: claims '${String(f.outOfReach)}', then names a program-building call:\n${f.message}`,
    );
  }
}

test('the fan-out guard declines before working → claims only this call is out of reach', () => {
  const args = { name: 'Button' };
  const f = semanticFanoutRefusal(
    { opName: 'trace_prop_through_tree', daemon: { isolation: 'in-process' } },
    ts,
    undefined,
    args,
  );
  assert.ok(f !== undefined);
  assert.equal(f.outOfReach, 'this-call');
  assertAgrees(f, 'trace_prop_through_tree', args);
});

// The sharp case, and the one the defect shipped: with a file already pinned, the guard's redirect
// legitimately re-pins the same op (a program build — the engine is fine). The SAME question after
// a dead engine may not, because the heap is what ran out, not the addressing.
test('a dead engine claims every program build is out of reach — and then names none', () => {
  const args = { name: 'Button', prop: 'size', file: 'src/Button.tsx' };
  const guard = opRefusal(
    { opName: 'trace_prop_through_tree' },
    { tool: 'size-guard', outOfReach: 'this-call', args, head: 'declined.', tail: 'cause.' },
  );
  const died = wireRefusal('trace_prop_through_tree', {
    tool: 'oom',
    outOfReach: 'any-program-build',
    args,
    head: 'trace_prop_through_tree cannot complete on this repo.',
    tail: 'Cause: out of memory.',
  });

  assert.equal(
    namesAProgramBuild('trace_prop_through_tree', args, guard.message),
    true,
    'with the engine intact the re-pin IS the right answer — the claim must not suppress it',
  );
  assertAgrees(guard, 'trace_prop_through_tree', args);
  assertAgrees(died, 'trace_prop_through_tree', args);
  assert.ok(
    !died.message.includes('trace_prop_through_tree {'),
    `the dead-engine refusal echoed back the call that died:\n${died.message}`,
  );

  // Every claim that is NOT the licensing one gets the same treatment — asserted over the union
  // rather than over the two members that happened to exist when this was written, since a claim
  // arriving unchecked is the hole this file is for.
  for (const claim of EVERY_CLAIM.filter((c) => c !== 'this-call')) {
    assertAgrees(
      wireRefusal('trace_prop_through_tree', {
        tool: 'engine-process',
        outOfReach: claim,
        args,
        head: 'trace_prop_through_tree did not complete.',
        tail: 'Cause: the engine exited.',
      }),
      'trace_prop_through_tree',
      args,
    );
  }
});

// The field is the input to the prose, not a label beside it: flipping the claim must move the
// redirect. A producer that set one and rendered the other would pass every message-shape test.
test('the redirect is derived from the claim — flipping the claim changes the calls named', () => {
  const args = { name: 'Button', file: 'src/Button.tsx' };
  const spec = { tool: 't', args, head: 'h.', tail: 'x.' } as const;
  const intact = opRefusal({ opName: 'find_definition' }, { ...spec, outOfReach: 'this-call' });
  const dead = opRefusal(
    { opName: 'find_definition' },
    { ...spec, outOfReach: 'any-program-build' },
  );
  assert.notEqual(intact.message, dead.message, 'the claim must be load-bearing, not decorative');
  assert.equal(namesAProgramBuild('find_definition', args, intact.message), true);
  assert.equal(namesAProgramBuild('find_definition', args, dead.message), false);
});

// t-166631: an op cannot be told it is something else. The name in the refusal comes from the
// context the dispatcher stamped, and there is no parameter that could carry a different one.
test('a refusal names the op from its context, with no op-name parameter to get wrong', () => {
  const f = opRefusal(
    { opName: 'member_usages' },
    {
      tool: 't',
      outOfReach: 'this-call',
      args: { name: 'Button' },
      head: 'member_usages declines.',
    },
  );
  assert.match(f.message, /^member_usages declines\./);
});

// A wire-side failure has no OpDefinition (the op never ran), so the request being failed is the
// only authority — and each request in a batch gets its own redirect, not the first one's.
test('a wire refusal addresses the request it is failing, per request', () => {
  const reqs = [
    { name: 'find_usages', args: { name: 'Alpha' } },
    { name: 'importers_of', args: { module: 'src/x.ts' } },
  ];
  const messages = reqs.map(
    (r) =>
      wireRefusal(r.name, {
        tool: 'oom',
        outOfReach: 'any-program-build',
        args: r.args,
        head: `${r.name} cannot complete on this repo.`,
        tail: 'Cause: out of memory.',
      }).message,
  );
  assert.match(messages[0] ?? '', /^find_usages /);
  assert.match(messages[0] ?? '', /"Alpha"/);
  assert.match(messages[1] ?? '', /^importers_of /);
  assert.doesNotMatch(messages[1] ?? '', /Alpha/, 'a batch must not reuse the first redirect');
});
