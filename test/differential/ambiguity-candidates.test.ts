// The ambiguity candidate list a bare `{name}` returns — the answer an agent's NEXT call is built
// on. Three properties, each independently falsifiable on a barrel-heavy name (the shape that broke
// it: a re-export chain produces many same-named ALIAS specifiers that outnumber the one real
// declaration):
//   · COMPLETENESS — the real declaration is IN the list (a target that isn't shown can't be picked,
//     §3.4). The pre-fix resolver spent a fuzzy-ranked budget of 10 BEFORE filtering by exact name
//     and before the definition-dedup, so past ~10 barrels the declaration was simply absent.
//   · HONEST COUNT — the number the message states equals the real number of distinct declaration
//     sites, or carries an explicit truncation marker. A count that looks complete while it isn't is
//     the §3.4 lie in its purest form (the pre-fix message said "10 distinct declarations" when
//     there were 13, with no marker).
//   · RANKING — a real declaration outranks every alias, so the default pick is the declaration.
//
// The truncation-honesty half of the same seam (the LS page cap: floors, refusals, no false
// incompleteness) lives in `search-truncation-honesty.test.ts`.
//
// Independent oracles: (1) the fixture's construction — N barrels each re-exporting its OWN impl
// yields exactly N+1 distinct declaration sites, a number the resolver never sees; (2) the
// rank-independent `name+file` addressing path, which resolves the real declaration without navto
// ranking at all — its SymbolId must be the one the ambiguity list leads with.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { project, type TestProject } from '../helpers/project.ts';
import { barrelRepo, counts, defId, failMsg, listedIds } from '../helpers/ambiguity.ts';

test('barrel-heavy ambiguity: the real declaration is listed, ranked first, and the count is true', async () => {
  // 20 barrels — well past the 8-candidate DISPLAY cap and past the pre-fix budget of 10, but
  // inside the 50-candidate search budget, so the total must be EXACT (no lower-bound marker).
  const p: TestProject = await project(barrelRepo(20));
  try {
    const msg = failMsg(await p.op('find_usages', { name: 'Widget' }));
    const { shown, total, lowerBound } = counts(msg);

    // Oracle 1 — construction: 20 alias declarations + 1 real declaration.
    assert.equal(
      total,
      21,
      `stated total must equal the 21 declarations the fixture builds: ${msg}`,
    );
    assert.equal(
      lowerBound,
      false,
      'the search budget was not hit — the count is exact, not a floor',
    );

    // No silent truncation: the display cap is disclosed, and shown + hidden reconciles to total.
    const ids = listedIds(msg);
    assert.equal(ids.length, shown, 'the message lists exactly as many SymbolIds as it claims');
    assert.ok(
      shown < total,
      'this fixture exceeds the display cap — the capped case is under test',
    );
    const more = msg.match(/!! (\d+) more not shown/);
    assert.ok(more !== null, `a capped list must carry an explicit truncation marker: ${msg}`);
    assert.equal(shown + Number(more[1]), total, 'shown + hidden reconciles to the stated total');

    // Oracle 2 — the rank-independent `name+file` path resolves the real declaration; the list
    // must LEAD with that same symbol (completeness + ranking in one assert: an alias-first or
    // declaration-absent list fails here).
    const real = defId(await p.op('find_usages', { name: 'Widget', file: 'src/z/widget.ts' }));
    assert.equal(ids[0], real, `the real declaration must be listed first: ${msg}`);
    assert.ok(
      msg.includes(`${real} (function`),
      'the leading candidate is the function declaration',
    );

    // Every other listed candidate is an alias, and each names the declaration it stands for —
    // so picking one is informed, not a guess.
    for (const id of ids.slice(1)) {
      assert.match(
        msg,
        new RegExp(
          `${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\(alias → src/a/impl\\d+\\.ts:\\d+:\\d+\\)`,
        ),
        `alias candidate ${id} must disclose its target declaration`,
      );
    }
  } finally {
    await p.dispose();
  }
});

test('past the search budget the ambiguity count is marked a LOWER BOUND, never a complete-looking number', async () => {
  // 60 barrels — beyond the 50-candidate search budget, so the resolver CANNOT know the true
  // total. It must say so (`≥`) instead of printing the truncated number as if it were complete.
  const p: TestProject = await project(barrelRepo(60));
  try {
    const msg = failMsg(await p.op('find_usages', { name: 'Widget' }));
    const { shown, total, lowerBound } = counts(msg);
    assert.ok(lowerBound, `a budget-truncated candidate set must be marked as a floor: ${msg}`);
    assert.ok(
      total <= 61 && total > shown,
      `the floor stays below the real 61 declarations: ${msg}`,
    );
    assert.match(msg, /LOWER BOUND/, 'the truncation is stated in words, not only as a glyph');
    // Still useful: the real declaration survives the budget because the exact-name filter runs
    // inside the search — the barrels never crowd it out.
    const real = defId(await p.op('find_usages', { name: 'Widget', file: 'src/z/widget.ts' }));
    assert.equal(listedIds(msg)[0], real, `the real declaration leads even at the budget: ${msg}`);
  } finally {
    await p.dispose();
  }
});

// A HELD SymbolId whose file changed must REBIND (§6), not read `gone`. The re-locate step runs the
// same workspace search, so it inherits the same failure mode: under a case-insensitive fuzzy flood
// a post-filtered page can come back without the held name at all, and the handle would then report
// "no symbol of this name/kind remains in the workspace" — a §6 misreport about code that is right
// there. Oracle: the same symbol addressed by `name+file` (the rank-independent AST path), which the
// rebind must land on.
const FLOOD_REBIND = ((): Record<string, string> => {
  const files: Record<string, string> = {
    'tsconfig.json': '{"compilerOptions":{"strict":true}}',
    'src/types.ts': 'export interface Span {\n  start: number;\n}\n',
  };
  // 25 lowercase `span` — more than the search budget used to retain, and every one of them an
  // exact-ish navto match for the query `Span` (navto is case-insensitive).
  for (let i = 0; i < 25; i++) files[`src/flood${i}.ts`] = `export const span = ${i};\n`;
  return files;
})();

test('a held SymbolId rebinds under a fuzzy flood instead of reporting the symbol gone', async () => {
  const p: TestProject = await project(FLOOD_REBIND);
  try {
    const held = defId(await p.op('find_usages', { name: 'Span', file: 'src/types.ts' }));
    assert.match(held, /Span@src\/types\.ts:1:18/, 'the handle is anchored on the declaration');

    // Move the declaration down a line: the handle's recorded position no longer holds the name,
    // which is exactly what forces the §6 rebind path.
    p.write('src/types.ts', '// a new first line\nexport interface Span {\n  start: number;\n}\n');

    const r = await p.op('find_usages', { symbolId: held });
    assert.ok(
      'result' in r && r.result.ok,
      `the handle must rebind, not go 'gone': ${JSON.stringify(r)}`,
    );
    const rebound = defId(r);
    const oracle = defId(await p.op('find_usages', { name: 'Span', file: 'src/types.ts' }));
    assert.equal(rebound, oracle, 'the rebind landed on the declaration at its new position');
    assert.match(rebound, /Span@src\/types\.ts:2:18/, 'and that position is the moved declaration');
  } finally {
    await p.dispose();
  }
});
