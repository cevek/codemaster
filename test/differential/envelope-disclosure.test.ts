// Resolve-time disclosure rides the ENVELOPE, so every op answering about a doubtful target says
// the same thing about it (§3.4/§3.6).
//
// The failure this guards is not a wrong number — it is two ops CONTRADICTING each other about one
// target in one session. `find_usages` discloses that a bare name resolved off a cut candidate page;
// `impact` answers `complete:true, dependents:0` and `member_usages` answers `complete:true` about
// the very same resolution. Both of those `complete` fields mean something narrower (the walk /
// program coverage for the RESOLVED symbol), so neither is strictly false — but an agent reading
// both cannot tell that, and will trust the confident one.
//
// The oracle is the fixture's construction, not another codemaster answer: the repo DECLARES five
// `interface Span`, and every op below answers about exactly ONE of them. So the claim "this is the
// only symbol of that name" is unsupportable for all five ops equally, and the assertion is
// cross-op EQUALITY of the envelope entry — a per-op verdict cannot satisfy it by accident.
//
// The negative arms are the other half of the contract: an EXACT target ranks no page, so inheriting
// the doubt would dress a complete answer as partial, and a page cut that hid no same-named
// declaration is not incompleteness at all. Both are the same lie inverted, and both have shipped
// before as false refusals.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { project, type TestProject } from '../helpers/project.ts';
import { floodRepo } from '../helpers/ambiguity.ts';
import type { OpResult } from '../../src/ops/contracts.ts';
import type { JsonValue } from '../../src/core/json.ts';
import type { Disclosure } from '../../src/core/result.ts';

/** The envelope's disclosures, read from EITHER arm — a failure built on a doubtful resolution needs
 *  the claim as much as a success does (an empty answer reads as absence either way). */
function disclosuresOf(r: OpResult): readonly Disclosure[] {
  assert.ok('result' in r, `expected an op result, got a dispatch error: ${JSON.stringify(r)}`);
  return r.result.disclosures ?? [];
}

/** The five ops that answer about one resolved ts target, with the args each needs. `find_usages`
 *  is the one that already disclosed (in its own `data`); the other four were mute. */
type Target = Record<string, JsonValue>;

const OPS: ReadonlyArray<{ op: string; args: (t: Target) => JsonValue }> = [
  { op: 'find_usages', args: (t) => t },
  { op: 'expand_type', args: (t) => t },
  { op: 'impact', args: (t) => t },
  { op: 'member_usages', args: (t) => ({ ...t, member: 'start0' }) },
  { op: 'source', args: (t) => ({ targets: [t] }) },
];

test('every op answering about a name resolved off a cut page carries the SAME envelope disclosure', async () => {
  // 199 `span` + 5 `Span`: the lowercase flood fills the LS page inside the exact-name bucket, so
  // the resolver saw a SUBSET of the five declarations and picked one of them.
  const p: TestProject = await project(floodRepo(199, 5));
  try {
    // Precondition, asserted not assumed: the resolution really was built on a cut page. Read from
    // find_usages' own pre-existing verdict, so this test cannot go green because the fixture
    // stopped overflowing the page.
    const seed = await p.op('find_usages', { name: 'Span' });
    assert.ok('result' in seed && seed.result.ok, JSON.stringify(seed));
    assert.equal(
      (seed.result.data as { searchTruncated?: boolean }).searchTruncated,
      true,
      'precondition: the candidate page must be cut inside the exact-name matches',
    );

    const seen: { op: string; disclosures: readonly Disclosure[] }[] = [];
    for (const { op, args } of OPS) {
      const r = await p.op(op, args({ name: 'Span' }));
      seen.push({ op, disclosures: disclosuresOf(r) });
    }

    const expected: Disclosure[] = [
      {
        unsafe: 'target-is-the-only-symbol-of-this-name',
        target: "name 'Span'",
        note: seen[0]?.disclosures[0]?.note ?? '',
      },
    ];
    assert.ok(
      (expected[0]?.note ?? '').length > 0,
      'the disclosure must carry a note naming the cause and the remedy',
    );
    for (const { op, disclosures } of seen) {
      assert.deepEqual(
        disclosures,
        expected,
        `${op} must carry the identical envelope disclosure — one op disclosing while its sibling ` +
          `answers confidently about the same target is the contradiction this channel removes`,
      );
    }
  } finally {
    await p.dispose();
  }
});

test('an EXACT target inherits no disclosure — a resolution that ranked nothing is not doubtful', async () => {
  const p: TestProject = await project(floodRepo(199, 5));
  try {
    // Same repo, same flood, same symbol — addressed exactly. `name+file` and `file:line:col` both
    // resolve rank-independently, so the page cut elsewhere says nothing about them. Marking these
    // would dress a COMPLETE answer as partial (§3.6) — the shape that previously blocked a
    // legitimate rename of a uniquely named symbol.
    const exact: Target[] = [
      { name: 'Span', file: 'src/t0.ts' },
      { file: 'src/t0.ts', line: 1, col: 18 },
    ];
    for (const target of exact) {
      for (const { op, args } of OPS) {
        const r = await p.op(op, args(target));
        assert.deepEqual(
          disclosuresOf(r),
          [],
          `${op} on the exact target ${JSON.stringify(target)} must NOT inherit the doubt`,
        );
      }
    }
  } finally {
    await p.dispose();
  }
});

test('a page cut that hid no same-named declaration is not disclosed — the claim, not the event', async () => {
  // 400 `SpannerThing*` beside one `Spanner`: the page overflows, but every EXACT-name candidate is
  // on it. The disclosure encodes what is unsafe to CLAIM ("may not be the only symbol of this
  // name"), not what happened upstream ("the page overflowed") — so nothing is disclosed here.
  const files: Record<string, string> = {
    'tsconfig.json': '{"compilerOptions":{"strict":true}}',
    'src/one.ts': 'export interface Spanner {\n  start: number;\n}\n',
  };
  for (let i = 0; i < 400; i++) {
    files[`src/p${i}.ts`] = `export interface SpannerThing${i} {\n  v: number;\n}\n`;
  }
  const p: TestProject = await project(files);
  try {
    // Precondition: the page really does overflow (else the test proves nothing).
    const page = await p.op('search_symbol', { query: 'Spanner', limit: 50 });
    assert.ok('result' in page && page.result.ok, JSON.stringify(page));
    assert.ok(
      page.result.truncated !== undefined,
      'the fixture must overflow the LS page for this arm to mean anything',
    );

    for (const { op, args } of OPS) {
      const r = await p.op(op, args({ name: 'Spanner' }));
      assert.deepEqual(
        disclosuresOf(r),
        [],
        `${op}: an unrelated PREFIX flood hides no same-named declaration — disclosing it would be ` +
          `false incompleteness`,
      );
    }
  } finally {
    await p.dispose();
  }
});
