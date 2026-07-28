// The OTHER half of the envelope-disclosure contract: which ASSEMBLY POINTS forward the channel.
// Every op executes through one dispatcher, but an envelope is BUILT in more than one place — a
// `sql` join assembles a fresh one over its producers' results. A claim stamped correctly and then
// dropped by a second factory is invisible exactly where it matters most, so these arms pin the
// factories rather than the ops (test/differential/envelope-disclosure.test.ts pins the ops).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { project, type TestProject } from '../helpers/project.ts';
import { floodRepo } from '../helpers/ambiguity.ts';
import type { OpResult } from '../../src/ops/contracts.ts';
import { disclosuresOf } from '../helpers/disclosure.ts';

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

// The disclosure covers a resolution that SUCCEEDED off a cut page. When the cut hid the name
// ENTIRELY the resolver fails instead — honestly, "could not determine whether 'X' exists" — and
// that failure must reach the agent AS a failure. An op that converts it into `ok{found:0}` makes
// "we could not find out" wear the shape of "nothing renders this field", which is not an incomplete
// answer but a positive claim about the repo that nothing established (§3.6); an agent acting on it
// deletes live code.
test('a name the cut page hid ENTIRELY fails — a couldn-t is never laundered into a proven absence', async () => {
  const files: Record<string, string> = {
    'package.json': JSON.stringify({ dependencies: { react: '18' } }),
    'tsconfig.json': '{"compilerOptions":{"strict":true,"jsx":"react-jsx","module":"preserve"}}',
    'src/types.ts': 'export interface User { Email: string }\n',
    'src/Card.tsx':
      "import type { User } from './types';\n" +
      'export const Card = (props: { user: User }) => <span>{props.user.Email}</span>;\n',
  };
  // 300 lowercase `email` against one `Email`: past the page budget the exact name never reaches
  // the page at all, so the resolver cannot say whether it exists.
  for (let i = 0; i < 300; i++) files[`src/f${i}.ts`] = `export const email = ${i};\n`;
  const p: TestProject = await project(files);
  try {
    // Precondition: the field DOES exist and IS rendered — so a `found:0` answer would be false,
    // not merely unhelpful. Proven independently of the name path, by position.
    const byLoc = await p.op('trace_field_to_render', { field: 'src/types.ts:1:26' });
    assert.ok('result' in byLoc && byLoc.result.ok, JSON.stringify(byLoc));
    assert.equal(
      (byLoc.result.data as { renderedBy?: number }).renderedBy,
      1,
      'precondition: addressed by position, the field resolves and Card renders it',
    );

    const byName = await p.op('trace_field_to_render', { field: 'Email' });
    assert.ok(
      'result' in byName && !byName.result.ok,
      `the name the page hid must FAIL, not answer found:0: ${JSON.stringify(byName)}`,
    );
    assert.match(
      byName.result.failure.message,
      /could not determine|result cap/,
      `and the failure says it could not, not that nothing matched: ${byName.result.failure.message}`,
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

    // The join's other two exits, as a regression net: they hold today, and each is a place a later
    // edit could drop the channel while the arm above stays green.
    const twoProducers = await p.request(
      [
        { name: 'find_usages', args: { name: 'Span' }, as: 'a' },
        { name: 'find_usages', args: { name: 'Span' }, as: 'b' },
      ],
      { sql: 'SELECT COUNT(*) AS n FROM a' },
    );
    const joined = twoProducers[twoProducers.length - 1];
    assert.ok(joined !== undefined && 'result' in joined, JSON.stringify(twoProducers));
    assert.equal(
      (joined.result.disclosures ?? []).length,
      1,
      'two producers doubting the SAME target state the claim once, not twice',
    );

    // SELECT-not-run: a producer failed, so the sql record is a FAILURE — which still has to carry
    // the claim, since an agent reading only the failure learns nothing about the target otherwise.
    const withFailure = await p.request(
      [
        { name: 'find_usages', args: { name: 'Span' }, as: 'a' },
        { name: 'find_usages', args: { name: 'NoSuchSymbolAnywhere' }, as: 'b' },
      ],
      { sql: 'SELECT COUNT(*) AS n FROM a' },
    );
    const failed = withFailure[withFailure.length - 1];
    assert.ok(
      failed !== undefined && 'result' in failed && !failed.result.ok,
      'the SELECT is skipped',
    );
    assert.deepEqual(
      (failed.result.disclosures ?? []).map((d) => d.unsafe),
      ['target-is-the-only-symbol-of-this-name'],
      'and the failure envelope keeps the surviving producer claim',
    );
  } finally {
    await p.dispose();
  }
});
