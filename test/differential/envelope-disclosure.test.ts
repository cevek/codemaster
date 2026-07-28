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
// only symbol of that name" is unsupportable for all of them equally, and the assertion is cross-op
// EQUALITY of the envelope entry — a per-op verdict cannot satisfy it by accident.
//
// The negative arms carry the same weight, because false doubt is the same lie inverted and on a
// mutation it blocks legitimate work: an EXACT target ranks no page, a cut that hid no same-named
// declaration is not incompleteness, and a neighbouring request in one batch never inherits another's
// claim (bleed is the characteristic failure of an ambient channel).

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
  // The claim is stated at RESOLVE time, before the op does any work — so an op that resolved and
  // then failed still satisfies a disclosure assertion. Pinning `ok` here keeps every arm a
  // statement about a real ANSWER: without it, a fixture drift that turned an op into a failure
  // (e.g. a different `Span` surviving the page cut, whose member `start0` does not exist) would
  // leave the arm green while testing nothing.
  assert.ok(r.result.ok, `expected the op to answer, got: ${JSON.stringify(r.result)}`);
  return r.result.disclosures ?? [];
}

type Target = Record<string, JsonValue>;

/** Per-fixture facts the ops need beyond the target: the member every declaration in that fixture
 *  carries, and the declaration text a trial edit rewrites it to. Passed in rather than hardcoded so
 *  an arm cannot silently degrade into a FAILING op that still satisfies a disclosure assertion. */
type Fixture = { member: string; replace: string };

/** EVERY read op that resolves a ts target — derived from the producer, not from a reading of which
 *  ops happen to forward a flag today. They all funnel through the ts plugin's one `resolve`, so
 *  they all inherit; enumerating them here is what turns "inherits by construction" from a claim
 *  into a measurement, and what makes a future op that forgets to forward anything still correct. */
const OPS: ReadonlyArray<{ op: string; args: (t: Target, f: Fixture) => JsonValue }> = [
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

const SPAN_FIXTURE: Fixture = {
  member: 'start0',
  replace: 'export interface Span { start0: string; }',
};

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
      const r = await p.op(op, args({ name: 'Span' }, SPAN_FIXTURE));
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
    // would dress a COMPLETE answer as partial (§3.6) — the shape that blocks a legitimate rename
    // of a uniquely named symbol.
    const exact: Target[] = [
      { name: 'Span', file: 'src/t0.ts' },
      { file: 'src/t0.ts', line: 1, col: 18 },
    ];
    for (const target of exact) {
      for (const { op, args } of OPS) {
        const r = await p.op(op, args(target, SPAN_FIXTURE));
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

// A react-plugin op reaches the same resolver by a DIFFERENT arg shape (`field`, not the shared
// `{symbolId|name|file+line+col}` target), and it forwards no truncation flag of its own. It is the
// case that decides whether the envelope actually removed the "every consumer must remember" class:
// if inheritance is a property of resolving, an op nobody adapted still discloses.
test('an op that forwards nothing and takes its own arg shape still inherits — the class is closed', async () => {
  const files: Record<string, string> = {
    'package.json': JSON.stringify({ dependencies: { react: '18' } }),
    'tsconfig.json': '{"compilerOptions":{"strict":true,"jsx":"react-jsx","module":"preserve"}}',
    'src/Card.tsx':
      "import type { User0 } from './t0';\n" +
      'export const Card = (props: { user: User0 }) => <span>{props.user.Email}</span>;\n',
  };
  // `floodRepo`'s shape, with the field name in place of the type: the lowercase flood fills the
  // page inside the exact-name bucket, and exactly one `Email` declaration survives past it — so
  // the name RESOLVES (not an ambiguity, not a miss) off a set we did not see whole.
  for (let i = 0; i < 199; i++) files[`src/f${i}.ts`] = `export const email = ${i};\n`;
  for (let i = 0; i < 5; i++)
    files[`src/t${i}.ts`] = `export interface User${i} { Email: string }\n`;
  const p: TestProject = await project(files);
  try {
    // Precondition, asserted not assumed: this fixture must actually cut the page. Without it the
    // arm would go green on a fixture too small to flood — proving nothing about inheritance.
    const seed = await p.op('find_definition', { name: 'Email' });
    assert.ok('result' in seed && seed.result.ok, JSON.stringify(seed));
    assert.equal(
      (seed.result.data as { searchTruncated?: boolean }).searchTruncated,
      true,
      'precondition: the field name must resolve off a cut page',
    );

    const traced = await p.op('trace_field_to_render', { field: 'Email' });
    assert.deepEqual(
      disclosuresOf(traced).map((d) => d.unsafe),
      ['target-is-the-only-symbol-of-this-name'],
      'trace_field_to_render resolves its `field` through the same resolver, so it discloses too',
    );
    // And the exact form of the SAME op stays clean — inheritance follows the resolution, not the op.
    const exact = await p.op('trace_field_to_render', { field: 'src/t0.ts:1:26' });
    assert.deepEqual(disclosuresOf(exact), [], 'a position-addressed field ranks nothing');
  } finally {
    await p.dispose();
  }
});

test('within one batch a disclosure stays on its own request — the ledger is per-op, not per-process', async () => {
  // The mechanism is an ambient (async-context) ledger, so its characteristic failure is BLEED: a
  // claim raised by one request appearing on a neighbour's envelope. Here request 1 resolves the
  // flooded bare name (doubtful) and request 2 resolves the SAME symbol exactly (not doubtful) in
  // the same batch, same engine, same process. Request 2 inheriting the claim would be false
  // incompleteness manufactured by the disclosure machinery itself — the worst outcome available,
  // because it would make the channel a source of the very lie it exists to prevent.
  const p: TestProject = await project(floodRepo(199, 5));
  try {
    const results = await p.request([
      { name: 'impact', args: { name: 'Span' } },
      { name: 'impact', args: { name: 'Span', file: 'src/t0.ts' } },
      { name: 'expand_type', args: { file: 'src/t0.ts', line: 1, col: 18 } },
    ]);
    assert.equal(results.length, 3);
    assert.equal(
      disclosuresOf(results[0] as OpResult).length,
      1,
      'the bare-name request must carry the claim',
    );
    assert.deepEqual(
      disclosuresOf(results[1] as OpResult),
      [],
      'the exact-target neighbour must NOT inherit it',
    );
    assert.deepEqual(
      disclosuresOf(results[2] as OpResult),
      [],
      'nor a later exact request in the same batch',
    );
  } finally {
    await p.dispose();
  }
});

// A `sql` join assembles a NEW envelope over its producers' results, so it is a second envelope
// factory — and the one place a dropped claim does the most damage: producers run UNCAPPED
// precisely so a `NOT IN` can be trusted, and a relation built on a possibly-mis-picked target is
// exactly the untrustworthy join that reasoning is meant to prevent. Under `return:'sql'` the
// per-request results are discarded, so the joined envelope is the ONLY place the claim can appear.
test('a sql join carries its producers disclosures — a second envelope factory may not drop the channel', async () => {
  const p: TestProject = await project(floodRepo(199, 5));
  try {
    const results = await p.request([{ name: 'find_usages', args: { name: 'Span' }, as: 't' }], {
      sql: 'SELECT COUNT(*) AS n FROM t',
    });
    const sql = results[results.length - 1];
    assert.ok(sql !== undefined && 'result' in sql, JSON.stringify(results));
    assert.deepEqual(
      (sql.result.disclosures ?? []).map((d) => d.unsafe),
      ['target-is-the-only-symbol-of-this-name'],
      'the SELECT ran over a relation built from a doubtful target — the join must say so',
    );
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
    'src/one.ts': 'export interface Spanner {\n  start0: number;\n}\n',
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
      const r = await p.op(
        op,
        args(
          { name: 'Spanner' },
          {
            member: 'start0',
            replace: 'export interface Spanner { start0: string; }',
          },
        ),
      );
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
