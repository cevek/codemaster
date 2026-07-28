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
import type { Disclosure } from '../../src/core/result.ts';
import { OPS, SPAN_FIXTURE, disclosuresOf, type Target } from '../helpers/disclosure.ts';

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

// The SAME claim, reached by a different cause: a nested tsconfig codemaster never loaded as a
// program may declare a distinct symbol of this name, so the resolved target may be the wrong one of
// several. The vocabulary is deliberately the claim and not the cause — an agent needs to know what
// the answer cannot assert, and the two causes make it unassertable identically.
test('an unindexed nested tsconfig raises the SAME claim — the vocabulary is the assertion, not its cause', async () => {
  const C = '{"strict":true,"target":"es2022","module":"esnext"}';
  const p: TestProject = await project({
    'tsconfig.json': `{"compilerOptions":${C},"include":["src"]}`,
    'src/lib.ts': 'export interface Shape {\n  a: number;\n}\n',
    // nested/ is NOT adjacent to the primary, NOT referenced, and has no package.json → the config
    // is never loaded, so the `Shape` it declares is invisible to every query below.
    'nested/tsconfig.json': `{"compilerOptions":${C},"include":["."]}`,
    'nested/app.ts': 'export interface Shape {\n  b: number;\n}\n',
  });
  const fixture = { member: 'a', replace: 'export interface Shape { a: string; }' };
  try {
    // Precondition: the page was NOT cut here (the repo is tiny) — so anything disclosed below comes
    // from the unindexed cause alone, and this arm cannot pass on the other cause's machinery.
    const seed = await p.op('find_usages', { name: 'Shape' });
    assert.ok('result' in seed && seed.result.ok, JSON.stringify(seed));
    assert.equal(
      (seed.result.data as { searchTruncated?: boolean }).searchTruncated,
      undefined,
      'precondition: no candidate-set cut in this fixture',
    );

    for (const { op, args } of OPS) {
      const r = await p.op(op, args({ name: 'Shape' }, fixture));
      assert.deepEqual(
        disclosuresOf(r).map((x) => x.unsafe),
        ['target-is-the-only-symbol-of-this-name'],
        `${op} must raise the claim for an unindexed same-named twin`,
      );
      assert.match(
        disclosuresOf(r)[0]?.note ?? '',
        /nested\/tsconfig\.json/,
        'and the note names the config that could hide it',
      );
    }

    // File-pinned: the declaration is pinned, so a twin under an unloaded config cannot be the one
    // meant. Claiming doubt here would dress a complete resolution as partial (§3.6).
    for (const { op, args } of OPS) {
      const r = await p.op(op, args({ name: 'Shape', file: 'src/lib.ts' }, fixture));
      assert.deepEqual(disclosuresOf(r), [], `${op}: a file-pinned target inherits nothing`);
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
