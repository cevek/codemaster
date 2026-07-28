// Truncation honesty on the name→declaration path. Two independent caps can cut the candidate set:
// codemaster's own view budget, and the LS's navto page (sorted by matchKind + name with NO case
// tie-break, sliced BEFORE our exact-name filter — so a `span` flood can hide `Span` entirely).
// Four obligations, each with its own failure mode if dropped:
//   · a count built on a cut set is a stated LOWER BOUND, never a complete-looking number (§3.4);
//   · a name the page hid is an honest "could not determine", never "no symbol named X" (§3.6),
//     and the §6 rebind never reads it as `gone`;
//   · a SUCCESS built on a cut set discloses `complete:false` — `mergeDeclarations` in particular
//     must not union a subset while promising all;
//   · and none of that may fire on a COMPLETE answer: a false incompleteness is the same lie
//     inverted, and on a mutation it blocks legitimate work.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { project, type TestProject } from '../helpers/project.ts';
import { counts, defId, failMsg, floodRepo } from '../helpers/ambiguity.ts';

test('a navto-sliced page is reported as a LOWER BOUND, never as a complete count', async () => {
  // 150 `span` + 60 `Span`: the LS page (50 × 4) fills with the lowercase flood, so the retained
  // exact-name set is capped by navto itself and `total` happens to equal what we show.
  const p: TestProject = await project(floodRepo(150, 60));
  try {
    const msg = failMsg(await p.op('find_usages', { name: 'Span' }));
    const { total, lowerBound } = counts(msg);
    // Oracle: the fixture declares 60 `Span`; anything below that MUST be marked a floor.
    assert.ok(
      lowerBound || total === 60,
      `a navto-truncated candidate set must be marked as a lower bound (stated ${total} of 60): ${msg}`,
    );
    assert.match(msg, /LOWER BOUND/, 'the floor is stated in words, not only as a glyph');
  } finally {
    await p.dispose();
  }
});

test('a name buried past the LS page is an honest "could not determine", never "no symbol named"', async () => {
  // 250 `span` + 1 `Span`: the exact name does not make it onto the page at all. Claiming absence
  // there is indistinguishable — to the agent — from a real absence, so it must not be claimed.
  const p: TestProject = await project(floodRepo(250, 1));
  try {
    const msg = failMsg(await p.op('find_usages', { name: 'Span' }));
    assert.doesNotMatch(
      msg,
      /no symbol named 'Span'/,
      `the declaration exists in src/t0.ts — absence must not be claimed: ${msg}`,
    );
    assert.match(msg, /could not determine|result cap/, `the answer states it could not: ${msg}`);
    // And the rank-independent path still resolves it, which is what the message steers to.
    const real = defId(await p.op('find_usages', { name: 'Span', file: 'src/t0.ts' }));
    assert.match(real, /Span@src\/t0\.ts/, 'name+file resolves the symbol the flood buried');
  } finally {
    await p.dispose();
  }
});

// The `ok` path of the same truncation: when the LS's sliced page leaves exactly ONE candidate, the
// resolve SUCCEEDS — and would then imply a uniqueness it never verified. `mergeDeclarations` makes
// the implication explicit ("union the usages of ALL same-named declarations"), so a union over a
// subset must say so. Oracle: the fixture declares 5 `Span`; the answer must either cover all of
// them or carry the machine-readable lower-bound verdict (§3.4).
test('a resolution built on a sliced page discloses that it may not be the only declaration', async () => {
  const p: TestProject = await project(floodRepo(199, 5));
  try {
    const single = await p.op('find_usages', { name: 'Span' });
    assert.ok('result' in single && single.result.ok, JSON.stringify(single));
    const d = single.result.data as { complete?: boolean; searchTruncated?: boolean };
    assert.equal(d.complete, false, 'a single resolution off a sliced page is a floor, not a fact');
    assert.equal(d.searchTruncated, true, 'and the cause is machine-readable, not prose-only');

    const merged = await p.op('find_usages', { name: 'Span', mergeDeclarations: true });
    assert.ok('result' in merged && merged.result.ok, JSON.stringify(merged));
    const m = merged.result.data as {
      complete?: boolean;
      mergedDeclarations?: unknown[];
      notes?: string[];
    };
    const covered = m.mergedDeclarations?.length ?? 1;
    assert.ok(
      covered === 5 || m.complete === false,
      `a merge over ${covered} of 5 declarations must not read as "all of them": ${JSON.stringify(m)}`,
    );
    assert.ok(
      (m.notes ?? []).some((n) => /LOWER BOUND/.test(n)),
      `the verdict is stated in the notes too: ${JSON.stringify(m.notes)}`,
    );

    // find_definition carries the same verdict — one op must not disclose while its sibling hides.
    const def = await p.op('find_definition', { name: 'Span' });
    assert.ok('result' in def && def.result.ok, JSON.stringify(def));
    assert.equal(
      (def.result.data as { complete?: boolean }).complete,
      false,
      'find_definition discloses the same floor',
    );
  } finally {
    await p.dispose();
  }
});

// A MUTATION may not ride an ambiguity gate that silently did not run (§7). The gate is "a bare name
// must match exactly one declaration" — but under a sliced page the resolver only ever saw a subset,
// so the same call refuses without a flood and would write with it. Oracle: the identical five
// declarations, with and without the flood, must reach the SAME verdict (a refusal).
test('a bare-name rename refuses when the candidate page was sliced — the gate cannot be faked by a flood', async () => {
  const clean: TestProject = await project(floodRepo(0, 5));
  try {
    const r = await clean.op('rename_symbol', { name: 'Span', newName: 'Spanned' });
    assert.ok(
      'result' in r && !r.result.ok,
      `5 same-named declarations must refuse: ${JSON.stringify(r)}`,
    );
    assert.match(r.result.failure.message, /ambiguous/, 'and it refuses AS ambiguity');
  } finally {
    await clean.dispose();
  }

  const flooded: TestProject = await project(floodRepo(199, 5));
  try {
    const r = await flooded.op('rename_symbol', { name: 'Span', newName: 'Spanned' });
    assert.ok(
      'result' in r && !r.result.ok,
      `the same 5 declarations must still refuse when a flood hides four of them: ${JSON.stringify(r)}`,
    );
    assert.match(
      r.result.failure.message,
      /result cap|ambiguous/,
      `the refusal names the reason it cannot verify the gate: ${r.result.failure.message}`,
    );
    // And it stays a dry refusal: nothing is written even with apply.
    const applied = await flooded.op('rename_symbol', {
      name: 'Span',
      newName: 'Spanned',
      apply: true,
    });
    assert.ok(
      'result' in applied && !applied.result.ok,
      'apply refuses too — never a silent write',
    );
  } finally {
    await flooded.dispose();
  }
});

// The merge path's own truncation axis: `mergeDeclarations` promises the union over ALL same-named
// declarations, so a union built from a candidate list OUR budget cut short must say so — the FAIL
// path already does, and an op that discloses when it refuses but hides when it answers is the same
// §3.4 lie in its quieter form.
test('mergeDeclarations discloses when the candidate budget — not just the LS page — cut the set', async () => {
  const files: Record<string, string> = {
    'tsconfig.json': '{"compilerOptions":{"strict":true,"target":"es2022","module":"esnext"}}',
  };
  // 60 barrels, each re-exporting its OWN implementation: 61 distinct declarations, past the
  // 50-candidate view budget but well inside the LS page.
  for (let i = 1; i <= 60; i++) {
    files[`src/impl${i}.ts`] =
      `export default function WidgetImpl${i}(): number {\n  return ${i};\n}\n`;
    files[`src/barrel${i}.ts`] = `export { default as Widget } from './impl${i}';\n`;
    files[`src/use${i}.ts`] =
      `import { Widget } from './barrel${i}';\nexport const use${i} = () => Widget;\n`;
  }
  files['src/z.ts'] = 'export function Widget(label: string): string {\n  return label;\n}\n';
  const p: TestProject = await project(files);
  try {
    const r = await p.op('find_usages', { name: 'Widget', mergeDeclarations: true });
    assert.ok('result' in r && r.result.ok, JSON.stringify(r));
    const d = r.result.data as {
      complete?: boolean;
      searchTruncated?: boolean;
      mergedDeclarations?: unknown[];
    };
    const covered = d.mergedDeclarations?.length ?? 0;
    assert.ok(covered < 61, `precondition: the budget cut the set (covered ${covered} of 61)`);
    assert.equal(d.complete, false, 'a union over a cut set must not read as "all of them"');
    assert.equal(d.searchTruncated, true, 'and the cause is machine-readable');
  } finally {
    await p.dispose();
  }
});

// The truncation bit is computed over navto's FUZZY page but consumed as "candidates of THIS name
// may be missing". A flood of unrelated PREFIX matches (`SpannerThing…` beside one `Spanner`) cuts
// the page without hiding a single same-named declaration — treating that as incompleteness refuses
// an unambiguous rename and stamps a complete read as a floor. False incompleteness is the same lie
// inverted (§3.6), and on a mutation it is worse: it blocks legitimate work.
function prefixFloodRepo(n: number): Record<string, string> {
  const files: Record<string, string> = {
    'tsconfig.json': '{"compilerOptions":{"strict":true}}',
    'src/one.ts': 'export interface Spanner {\n  start: number;\n}\n',
  };
  for (let i = 0; i < n; i++) {
    files[`src/p${i}.ts`] = `export interface SpannerThing${i} {\n  v: number;\n}\n`;
  }
  return files;
}

test('a fuzzy PREFIX flood is not incompleteness: the unique name still resolves, reads stay complete, the rename runs', async () => {
  const p: TestProject = await project(prefixFloodRepo(400));
  try {
    // Precondition, asserted not assumed: the page really IS cut here (else this test would go
    // green for the wrong reason if a future change shrank the fixture below the LS budget).
    const page = await p.op('search_symbol', { query: 'Spanner', limit: 50 });
    assert.ok('result' in page && page.result.ok, JSON.stringify(page));
    assert.ok(
      page.result.truncated !== undefined,
      'the fixture must overflow the LS page for this test to mean anything',
    );

    const r = await p.op('find_usages', { name: 'Spanner' });
    assert.ok(
      'result' in r && r.result.ok,
      `the name is unique — it must resolve: ${JSON.stringify(r)}`,
    );
    const d = r.result.data as { complete?: boolean; searchTruncated?: boolean };
    assert.equal(d.searchTruncated, undefined, 'no same-named candidate was cut — no floor');
    assert.equal(d.complete, undefined, 'and no lower-bound verdict on a complete answer');

    // The write path is where a false floor costs most: it would refuse a legitimate refactor.
    const renamed = await p.op('rename_symbol', { name: 'Spanner', newName: 'Spanned' });
    assert.ok(
      'result' in renamed && renamed.result.ok,
      `a unique name must stay renameable under a prefix flood: ${JSON.stringify(renamed)}`,
    );
  } finally {
    await p.dispose();
  }
});

// A held SymbolId is exact addressing. When its §6 rebind re-locates the symbol in the handle's OWN
// file, no ranked page chose the target — so a slice elsewhere must not turn the follow-up mutation
// into a refusal (the find_definition → edit → rename_symbol chain §6 exists for).
test('a rebound handle stays mutable under a flood — an exact target needs no ambiguity gate', async () => {
  const p: TestProject = await project(floodRepo(250, 1));
  try {
    const held = defId(await p.op('find_usages', { name: 'Span', file: 'src/t0.ts' }));
    p.write('src/t0.ts', '// a new first line\nexport interface Span {\n  start0: number;\n}\n');

    const renamed = await p.op('rename_symbol', { symbolId: held, newName: 'Spanned' });
    assert.ok(
      'result' in renamed && renamed.result.ok,
      `a rebound handle must stay mutable: ${JSON.stringify(renamed)}`,
    );
  } finally {
    await p.dispose();
  }
});
