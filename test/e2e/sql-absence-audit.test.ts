// The ABSENCE audit the `concepts: absence-audit` recipe documents (t-933867): "which member of a
// family does NOT call F" answered as one `batch + sql` anti-join over two `find_usages` producers —
// the family taken from the call sites of its own factory (every codemaster op is one `defineOp(…)`
// call), F from its own call sites, LEFT-JOINed on `file`.
//
// Oracle = the fixture: which member calls the guard is known by construction, and the expected hole
// set is written out, so a recipe that silently stops working (a producer capped, the role filter
// dropping a site, the join key collapsing two members) fails here instead of reading as "no holes"
// — the §3.4 lie the audit exists to prevent. The recipe's two stated caveats are asserted as
// BEHAVIOUR, not prose: the one-member-per-file precondition, and the direction the residual error
// leans (a member whose F-call sits in a helper file reads as a hole — an UPPER bound / false alarm,
// never a missed hole).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { project } from '../helpers/project.ts';
import type { OpResult } from '../../src/ops/contracts.ts';

/** A miniature of `src/ops/**`: a `defineOp` factory + a `guardCheck` every member SHOULD call.
 *  a/c call it inline · b/d do not (the holes) · e calls it only from a HELPER file. */
const OPS_FAMILY = {
  'tsconfig.json': '{"compilerOptions":{"strict":true}}',
  'src/reg.ts': `export function defineOp<T>(d: T): T { return d; }\nexport const guardCheck = (n: number): boolean => n > 0;\n`,
  'src/ops/a.ts': `import { defineOp, guardCheck } from '../reg';\nexport const aOp = defineOp({ run: () => guardCheck(1) });\n`,
  'src/ops/b.ts': `import { defineOp } from '../reg';\nexport const bOp = defineOp({ run: () => 2 });\n`,
  'src/ops/c.ts': `import { defineOp, guardCheck } from '../reg';\nexport const cOp = defineOp({ run: () => guardCheck(3) });\n`,
  'src/ops/d.ts': `import { defineOp } from '../reg';\nexport const dOp = defineOp({ run: () => 4 });\n`,
  'src/ops/e.ts': `import { defineOp } from '../reg';\nimport { viaHelper } from './e-helper';\nexport const eOp = defineOp({ run: () => viaHelper() });\n`,
  'src/ops/e-helper.ts': `import { guardCheck } from '../reg';\nexport const viaHelper = (): boolean => guardCheck(5);\n`,
};

function okData(r: OpResult): { columns: string[]; rows: unknown[][] } & Record<string, unknown> {
  assert.ok('result' in r, `expected result, got ${JSON.stringify(r)}`);
  assert.ok(r.result.ok, `expected ok, got ${JSON.stringify(r.result)}`);
  return r.result.data as { columns: string[]; rows: unknown[][] } & Record<string, unknown>;
}

/** The recipe's two producers, verbatim in shape: the family from its factory's call sites (scoped
 *  to the family's own tree), F from its own. */
const PRODUCERS = [
  {
    name: 'find_usages',
    as: 'fam',
    args: {
      name: 'defineOp',
      role: 'call',
      filter: { pathInclude: ['src/ops/**'] },
    },
  },
  { name: 'find_usages', as: 'f', args: { name: 'guardCheck', role: 'call' } },
];

test('absence-audit recipe: the anti-join returns exactly the family members that never call F', async () => {
  const p = await project(OPS_FAMILY);
  try {
    const results = await p.request(PRODUCERS, {
      sql: 'SELECT fam.file FROM fam WHERE fam.file NOT IN (SELECT file FROM f) ORDER BY fam.file',
    });
    const holes = okData(results[0] as OpResult).rows.map((row) => row[0]);
    // b/d never call it. e calls it only through e-helper.ts, so the file join key cannot see it —
    // the documented over-report (an upper bound on the holes), asserted so the recipe's stated
    // direction is a tested fact rather than a claim in prose.
    assert.deepEqual(
      holes,
      ['src/ops/b.ts', 'src/ops/d.ts', 'src/ops/e.ts'],
      'a/c call the guard inline; b/d never do; e only via a helper file (over-report, by design)',
    );
  } finally {
    await p.dispose();
  }
});

test('absence-audit: the one-member-per-file precondition is itself a query (a 2-op file hides a hole)', async () => {
  // The join key is the FILE, so two family members in one file — one guarded, one not — would make
  // the unguarded one read as guarded: an UNDER-report, the one direction an audit must never take.
  // The recipe tells the agent to check this first; the check must actually discriminate, so the
  // fixture violates it deliberately.
  const p = await project({
    ...OPS_FAMILY,
    'src/ops/pair.ts': `import { defineOp, guardCheck } from '../reg';\nexport const p1 = defineOp({ run: () => guardCheck(6) });\nexport const p2 = defineOp({ run: () => 7 });\n`,
  });
  try {
    const results = await p.request(PRODUCERS, {
      sql: 'SELECT fam.file, COUNT(*) AS c FROM fam GROUP BY fam.file HAVING c > 1',
    });
    const flagged = okData(results[0] as OpResult).rows;
    assert.deepEqual(
      flagged,
      [['src/ops/pair.ts', 2]],
      'the precondition query names the file whose second member the anti-join would hide',
    );

    // And the hole it hides really is hidden — proof the precondition is load-bearing, not ritual.
    const anti = await p.request(PRODUCERS, {
      sql: 'SELECT fam.file FROM fam WHERE fam.file NOT IN (SELECT file FROM f) ORDER BY fam.file',
    });
    const holes = okData(anti[0] as OpResult).rows.map((row) => row[0]);
    assert.ok(
      !holes.includes('src/ops/pair.ts'),
      'p2 is unguarded yet pair.ts reads as covered — exactly what the precondition query catches',
    );
  } finally {
    await p.dispose();
  }
});

test('absence-audit: the family producer is a semantic set, not a text match', async () => {
  // Why the recipe uses find_usages and not grep for the family: a call the text pattern
  // `defineOp({` misses (an aliased import, a non-adjacent brace) is still a member here. The
  // fixture aliases the import and breaks the line, so a grep-shaped producer would under-report
  // the family — and an under-reported family silently drops audit targets (§3.4).
  const p = await project({
    ...OPS_FAMILY,
    'src/ops/z.ts': `import { defineOp as makeOp } from '../reg';\nexport const zOp = makeOp(\n  { run: () => 8 },\n);\n`,
  });
  try {
    const results = await p.request(PRODUCERS, {
      sql: 'SELECT fam.file FROM fam WHERE fam.file NOT IN (SELECT file FROM f) ORDER BY fam.file',
    });
    const holes = okData(results[0] as OpResult).rows.map((row) => row[0]);
    assert.ok(
      holes.includes('src/ops/z.ts'),
      'the aliased, line-broken member is in the family — the anti-join reports its missing guard',
    );
  } finally {
    await p.dispose();
  }
});
