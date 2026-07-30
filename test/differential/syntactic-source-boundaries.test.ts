// t-229522 — the BOUNDARY half of the `source { syntactic: true }` honesty gate: everything this path
// must REFUSE, and what the refusal has to say. The successful-answer invariants (byte-equality with the
// checker path, no program build, batch survival, the rendered note) are `syntactic-source.test.ts`;
// both drive the one shared fixture so they reason about the same declarations.
//
// The oracle throughout is the CHECKER PATH: where it resolves and this one cannot, the miss must name the
// capability boundary; where IT refuses too, agreement on refusing is the assertion. Each arm guards a
// substitution that would look like an answer:
//  * an ALIAS address (a named import, AND a default import — which reaches the declaration index as a
//    bare identifier rather than any import-kind node, so a kind-list filter lets it through) must not
//    print the import line as the symbol's body, nor read as a same-named twin of the real declaration;
//  * a REFERENCE position, which the checker path FOLLOWS into another file, must not yield the enclosing
//    declaration in its place;
//  * same-named declarations in DIFFERENT SCOPES are rivals, not one merged symbol — a pick-list, never a
//    silent pick with the loser labelled "another definition of it";
//  * a `file+line` line holding several declarations is a pick-list, as on the checker path — and `./x`
//    or an absolute path resolves the same as the plain repo-relative spelling;
//  * a file that is not on the surface is told WHICH cause was established, never a guessed one.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { project } from '../helpers/project.ts';
import {
  SYNTACTIC_FIXTURE as FILES,
  locate,
  missReason,
  sole,
  sourceOf,
} from '../helpers/syntactic-source-fixture.ts';

test('an ALIAS address is an explicit miss, never an import line printed as a body', async () => {
  const p = await project(FILES);
  try {
    // The handle shape the OOM-safe search actually hands out: `search_symbol {syntactic:true}` mints
    // ids at import/re-export sites too, so this is the routine chained-handle case, not a corner.
    // `WidgetLimit`, not the renamed `makeWidget as build`: an import specifier is catalogued under its
    // LOCAL name, so only a plainly-imported symbol has an alias site under its own name.
    const found = await p.op('search_symbol', {
      query: 'WidgetLimit',
      syntactic: true,
      limit: 20,
    });
    assert.ok('result' in found && found.result.ok);
    const matches = (found.result.data as { matches?: Array<{ id: string; kind: string }> })
      .matches;
    const alias = matches?.find((m) => m.kind === 'alias');
    assert.ok(
      alias !== undefined,
      'the search really does mint an alias-site handle (non-vacuous)',
    );

    const data = await sourceOf(p, { symbolId: alias.id }, true);
    assert.equal(data.sources?.length ?? 0, 0, 'no body is printed for an alias site');
    const reason = missReason(data, 'alias site');
    assert.match(reason, /import \/ re-export re-mention/i, 'says WHAT the address holds');
    assert.match(reason, /no module specifier/i, 'says why it cannot follow it');
    assert.ok(!reason.includes('import { makeWidget'), 'and never quotes the import as the body');
  } finally {
    await p.dispose();
  }
});

test('a DEFAULT import is an alias too — not a declaration, and not a same-named twin', async () => {
  const p = await project(FILES);
  try {
    // A default-import binding reaches the declaration index as a bare Identifier rather than any
    // import-KIND node, so an alias filter written as a list of import kinds lets it through. Two lies
    // follow from that, and both are asserted here.
    //
    // (a) the import line printed as the symbol's body:
    const atImport = await sourceOf(p, { name: 'WidgetOwner', file: 'src/app.ts' }, true);
    assert.equal(atImport.sources?.length ?? 0, 0, 'the import binding is not a declaration');
    assert.match(
      missReason(atImport, 'default import'),
      /import \/ re-export re-mention/i,
      'a default import reads as an alias site, like a named one',
    );

    // (b) every importing file read as another declaration of the name. The checker path is the oracle:
    // it resolves the ONE real declaration, so the syntactic path must too — not a 2-file pick-list.
    const checker = sole(await sourceOf(p, { name: 'WidgetOwner' }, false), 'checker/default');
    const syn = sole(await sourceOf(p, { name: 'WidgetOwner' }, true), 'syntactic/default');
    assert.match(checker.decl.file, /owner\.ts$/, 'oracle resolves the real declaration');
    assert.equal(syn.decl.file, checker.decl.file, 'and so does the syntactic path');
    assert.equal(syn.decl.text, checker.decl.text, 'byte-identical body');
  } finally {
    await p.dispose();
  }
});

test('a REFERENCE position the checker path follows is an explicit miss here', async () => {
  const p = await project(FILES);
  try {
    // The `build({...})` call in app.ts — a call through an import alias. The oracle: the checker path
    // FOLLOWS it into widget.ts. Without that arm this test would pass even if the syntactic path
    // silently printed the enclosing `useWidget`. Position located by SEARCHING the fixture, so an edit
    // to it cannot silently retarget the assertion at some other line.
    const { line, col } = locate('src/app.ts', 'build(');
    const at = { file: 'src/app.ts', line, col };

    const followed = sole(await sourceOf(p, at, false), 'checker at a reference');
    assert.match(
      followed.decl.file,
      /widget\.ts$/,
      'the checker path resolves it to the DECLARATION',
    );

    const data = await sourceOf(p, at, true);
    assert.equal(data.sources?.length ?? 0, 0, 'the syntactic path prints nothing there');
    const reason = missReason(data, 'reference position');
    assert.match(reason, /cannot follow a reference/i, 'states the capability boundary');
    assert.ok(!reason.includes('useWidget'), 'and never offers the enclosing declaration instead');
  } finally {
    await p.dispose();
  }
});

test('same-named declarations in DIFFERENT SCOPES are a pick-list, never a silent pick', async () => {
  const p = await project(FILES);
  try {
    // `Alpha.twin` and `Beta.twin`: two unrelated symbols, one name, one file — TS accepts it, and this
    // surface indexes members, so it is routine rather than a corner case. The oracle is the checker
    // path, which REFUSES; agreement on refusing is the assertion.
    const checker = await sourceOf(p, { name: 'twin', file: 'src/rivals.ts' }, false);
    assert.equal(checker.sources?.length ?? 0, 0, 'the checker path refuses (non-vacuous oracle)');

    const syn = await sourceOf(p, { name: 'twin', file: 'src/rivals.ts' }, true);
    assert.equal(syn.sources?.length ?? 0, 0, 'the syntactic path refuses too');
    const reason = missReason(syn, 'scope rivals');
    assert.match(
      reason,
      /different symbols/i,
      'says they are different symbols, not one merged one',
    );
    // The pick-list IS the remedy, so both candidates must be in it as paste-able SymbolIds.
    assert.match(reason, /ts:twin@src\/rivals\.ts:2:/, 'lists the first candidate');
    assert.match(reason, /ts:twin@src\/rivals\.ts:5:/, 'lists the second candidate');

    // The inverse lie, guarded: a genuinely merged symbol must still resolve rather than read as rivals.
    // `WidgetProps` + a same-scope `namespace WidgetProps` would be the ideal case; the simpler proof is
    // that every unique top-level symbol above still resolves — asserted by the byte-equality test.
    const still = sole(
      await sourceOf(p, { name: 'makeWidget', file: 'src/widget.ts' }, true),
      'merge',
    );
    assert.ok(
      still.decl.text.includes('makeWidget'),
      'an unambiguous name is not dressed as a rival',
    );
  } finally {
    await p.dispose();
  }
});

test('a line holding several declarations is a pick-list; ./ and absolute paths resolve alike', async () => {
  const p = await project(FILES);
  try {
    // `export const pairA = 1, pairB = 2;` — two declarations, one line. The checker path refuses with a
    // pick-list; picking the first and calling the second "another definition" of it would be a merge
    // claim about two different symbols.
    const at = { file: 'src/rivals.ts', line: locate('src/rivals.ts', 'pairA').line };

    const checker = await sourceOf(p, at, false);
    assert.equal(checker.sources?.length ?? 0, 0, 'the checker path refuses (non-vacuous oracle)');
    const syn = await sourceOf(p, at, true);
    assert.equal(syn.sources?.length ?? 0, 0, 'the syntactic path refuses too');
    const reason = missReason(syn, 'multi-declarator line');
    assert.match(reason, /2 declarations/, 'counts them');
    assert.match(reason, /pairB at col/, 'names the one it did not pick, with its column');

    // A `./`-prefixed and an ABSOLUTE spelling of one file must reach the same declaration as the plain
    // repo-relative one — an agent has an absolute path in hand right after reading a file.
    const plain = sole(
      await sourceOf(p, { name: 'makeWidget', file: 'src/widget.ts' }, true),
      'plain',
    );
    for (const spelling of ['./src/widget.ts', `${p.root}/src/widget.ts`]) {
      const alt = sole(await sourceOf(p, { name: 'makeWidget', file: spelling }, true), spelling);
      assert.equal(alt.decl.text, plain.decl.text, `${spelling} resolves to the same declaration`);
    }
  } finally {
    await p.dispose();
  }
});

test('a file arg that is not on the surface names the cause it actually established', async () => {
  const p = await project(FILES);
  try {
    // The lookup only establishes "not a key in the surface map". Attributing that to "gitignored or
    // outside-root" without probing is the wrong-cause-wrong-remedy defect: each case must name its own.
    const cases: Array<[string, RegExp]> = [
      ['src/nope.ts', /no such file/i],
      ['src', /is a directory/i],
      ['tsconfig.json', /not TypeScript source/i],
    ];
    for (const [file, expected] of cases) {
      const data = await sourceOf(p, { name: 'makeWidget', file }, true);
      const reason = missReason(data, file);
      assert.match(reason, expected, `${file}: names its own cause`);
      assert.ok(
        !/gitignored/i.test(reason),
        `${file}: must not attribute an unestablished cause — got: ${reason}`,
      );
    }
  } finally {
    await p.dispose();
  }
});
