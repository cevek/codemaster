// Shared readers + the op table for the envelope-disclosure suites (§3.4/§3.6). Kept in one place
// so the two suites — inheritance (which ops carry the claim) and envelope factories (which
// assembly points forward it) — cannot drift on WHAT they consider the full set of resolving ops.

import assert from 'node:assert/strict';
import type { OpResult } from '../../src/ops/contracts.ts';
import type { JsonValue } from '../../src/core/json.ts';
import type { Disclosure } from '../../src/core/result.ts';

export type Target = Record<string, JsonValue>;

/** Per-fixture facts the ops need beyond the target: the member every declaration in that fixture
 *  carries, and the declaration text a trial edit rewrites it to. Passed in rather than hardcoded so
 *  an arm cannot silently degrade into a FAILING op that still satisfies a disclosure assertion. */
export type Fixture = { member: string; replace: string };

/** The envelope's disclosures. Pins `ok` deliberately: the claim is stated at RESOLVE time, before
 *  the op does any work, so an op that resolved and then FAILED would still satisfy a disclosure
 *  assertion. Without this, a fixture drift that turned an op into a failure leaves the arm green
 *  while testing nothing. */
export function disclosuresOf(r: OpResult): readonly Disclosure[] {
  assert.ok('result' in r, `expected an op result, got a dispatch error: ${JSON.stringify(r)}`);
  assert.ok(r.result.ok, `expected the op to answer, got: ${JSON.stringify(r.result)}`);
  return r.result.disclosures ?? [];
}

/** EVERY read op that resolves a ts target — derived from the producer, not from a reading of which
 *  ops happen to forward a flag today. They all funnel through the ts plugin's one `resolve`, so
 *  they all inherit; enumerating them here is what turns "inherits by construction" from a claim
 *  into a measurement, and what makes a future op that forgets to forward anything still correct. */
export const OPS: ReadonlyArray<{ op: string; args: (t: Target, f: Fixture) => JsonValue }> = [
  { op: 'find_usages', args: (t) => t },
  { op: 'find_definition', args: (t) => t },
  { op: 'expand_type', args: (t) => t },
  { op: 'impact', args: (t) => t },
  { op: 'member_usages', args: (t, f) => ({ ...t, member: f.member }) },
  { op: 'source', args: (t) => ({ targets: [t] }) },
  { op: 'construction_sites', args: (t) => t },
  { op: 'discrimination_sites', args: (t) => t },
  { op: 'trace_type_widening', args: (t) => t },
  { op: 'impact_type_error', args: (t, f) => ({ ...t, edit: { replace: f.replace } }) },
];

export const SPAN_FIXTURE: Fixture = {
  member: 'start0',
  replace: 'export interface Span { start0: string; }',
};
