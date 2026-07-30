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
    assert.match(reason, /different scopes/i, 'reports the boundary it observed');
    // …and does NOT convert that observation into a verdict on identity: two `declare global` blocks and a
    // function-scoped `var` in two blocks are ONE symbol in different scopes, and only the checker can
    // tell those from two symbols. A refusal is honest; a refusal that asserts distinctness is not.
    assert.ok(
      !/makes these different symbols/i.test(reason),
      `must not claim distinctness it cannot prove — got: ${reason}`,
    );
    assert.match(reason, /cannot tell separate symbols/i, 'states the inability instead');
    // The pick-list IS the remedy, so both candidates must be in it as paste-able SymbolIds.
    assert.match(reason, /ts:twin@src\/rivals\.ts:2:/, 'lists the first candidate');
    assert.match(reason, /ts:twin@src\/rivals\.ts:5:/, 'lists the second candidate');

    // The inverse lie, guarded for real: a genuinely MERGED symbol must resolve AND list its other
    // declaration. Without this arm a policy that refused everything would stay green, which is what let
    // the merge branch ship untested in both directions.
    // Three merged symbols in three different containers (file / `namespace` body / class body). NOTE what
    // this can and cannot catch: a merge assertion is MONOTONE in the container list — dropping a container
    // makes both siblings over-climb TOGETHER, so no merge arm can red for a MISSING container. The arms
    // that DO catch a missing one are the rival arms, and only for the containers they name (arm 5's
    // loop / catch / switch-body / expando, and this arm's class members) — a dropped `isModuleBlock` is
    // caught by nothing here. What these merge cases guard is the opposite direction: a false SPLIT of a
    // genuine merge, in each of the three containers.
    for (const [name, bodyPattern] of [
      ['Both', /interface Both/],
      ['Deep', /interface Deep/],
      ['pair', /get pair/],
    ] as const) {
      const merged = sole(
        await sourceOf(p, { name, file: 'src/merged.ts' }, true),
        `merge/${name}`,
      );
      assert.match(merged.decl.text, bodyPattern, `${name}: the merged symbol resolves`);
      assert.equal(
        merged.moreDefinitions?.length,
        1,
        `${name}: its OTHER declaration is listed — the merge arm really merges`,
      );
    }
  } finally {
    await p.dispose();
  }
});

test('a shared enclosing node is not a shared BINDING scope — loop, catch, and expando rivals', async () => {
  const p = await project(FILES);
  try {
    // Three shapes whose declarations share the node that ENCLOSES them while binding in separate
    // regions: two `for (let idx…)` headers, two `catch (err)` clauses, and two expando assignments on
    // DIFFERENT objects (`Owner.tag` / `Other.tag` — an expando binds no scope at all, so scope identity
    // alone cannot separate them). Each pair is two symbols; merging them would claim one is "another
    // definition" of the other.
    for (const name of ['idx', 'err', 'cse', 'tag', 'mixed']) {
      const data = await sourceOf(p, { name, file: 'src/merged.ts' }, true);
      assert.equal(data.sources?.length ?? 0, 0, `${name}: must not resolve to one of two symbols`);
      const reason = missReason(data, name);
      // The pick-list IS the remedy, so every candidate must be in it as a paste-able SymbolId — a
      // regression that emptied the list would otherwise stay green on the prose alone.
      assert.equal(
        (reason.match(new RegExp(`ts:${name}@`, 'g')) ?? []).length,
        2,
        `${name}: both candidates listed as SymbolIds — got: ${reason}`,
      );
      // And it may state only what it OBSERVED: an expando pair shares its scope (the assignment target
      // separated it), so claiming a scope boundary there would be an invented cause.
      const isAssignment = name === 'tag' || name === 'mixed';
      const expectedCause = isAssignment
        ? name === 'tag'
          ? /on 2 distinct objects/i
          : /not a property assignment at all/i
        : /different scopes/i;
      assert.match(reason, expectedCause, `${name}: names the cause that actually fired`);
      // The CAVEAT is licensed by the observation, and nothing else pins that pairing: a namespace /
      // declare-global merge and a function-scoped `var` are ways ONE symbol spans several REGIONS, so
      // citing them beside two assignments on different objects explains the answer with an irrelevance.
      assert.equal(
        /cannot tell separate symbols/i.test(reason),
        !isAssignment,
        `${name}: the merge caveat belongs to region causes only — got: ${reason}`,
      );
      assert.ok(
        !/makes these different symbols/i.test(reason),
        `${name}: must not assert distinctness it cannot prove — got: ${reason}`,
      );
    }
  } finally {
    await p.dispose();
  }
});

test('a stale handle landing among rivals refuses with the SAME description as the name path', async () => {
  const p = await project(FILES);
  try {
    // The handle path used to word its own refusal, so it contradicted the name path about the same two
    // declarations (an expando pair called a "scope boundary") and dropped the may-be-one-symbol caveat.
    // Both addressings must now describe one candidate set identically.
    const byName = missReason(
      await sourceOf(p, { name: 'tag', file: 'src/merged.ts' }, true),
      'name',
    );
    // A handle whose recorded position no longer holds the name → the workspace-wide rival branch.
    const stale = await sourceOf(p, { symbolId: 'ts:tag@src/merged.ts:999:1' }, true);
    const byHandle = missReason(stale, 'handle');

    assert.match(byHandle, /on 2 distinct objects/i, 'the handle path names the cause that fired');
    assert.ok(
      !/different scopes/i.test(byHandle),
      `an expando pair shares its scope — must not report a boundary: ${byHandle}`,
    );
    // The shared description, verbatim, so the two can never drift into contradicting each other.
    const shared = byName.slice(byName.indexOf('declarations named'));
    assert.ok(
      byHandle.includes(shared),
      `handle refusal must carry the name path's description verbatim:\n  name:   ${byName}\n  handle: ${byHandle}`,
    );
    assert.match(byHandle, /pick the one you mean/i, 'and still tells the agent what to do');
    // Exactly ONE remedy: the delegation used to leave the shared one beside the handle path's own
    // paraphrase of it.
    assert.equal(
      (byHandle.match(/pass one of these SymbolIds/g) ?? []).length,
      1,
      `the remedy must appear once, not twice: ${byHandle}`,
    );

    // The OTHER handle arm — candidates in other FILES, which the own-file arm excludes by construction
    // (`d.rel !== rel`), so this is the only thing that reaches it. Its recomputed file count is what the
    // wording keys on, and reporting two files as one is the cross-file contradiction this arm pins.
    const cross = await sourceOf(p, { symbolId: 'ts:farTwin@src/cross-a.ts:1:14' }, true);
    const crossReason = missReason(cross, 'cross-file handle');
    assert.match(crossReason, /in 2 files/, `must report both files: ${crossReason}`);
    assert.ok(!/of one file/i.test(crossReason), `two files must not read as one: ${crossReason}`);
    assert.match(crossReason, /ts:farTwin@src\/cross-b\.ts/, 'lists a candidate in one other file');
    assert.match(crossReason, /ts:farTwin@src\/cross-c\.ts/, 'and the one in the second');
    assert.match(crossReason, /pick the one you mean/i, 'and carries the remedy');
    // Verbatim agreement for the CROSS-FILE set as well: the same-file check above cannot see a divergence
    // that only a multi-file description would show (a recomputed file count, say).
    const crossByName = missReason(await sourceOf(p, { name: 'farTwin' }, true), 'cross byName');
    const crossShared = crossByName.slice(crossByName.indexOf('declarations named'));
    assert.ok(
      crossReason.includes(crossShared),
      `cross-file descriptions must match verbatim:\n  name:   ${crossByName}\n  handle: ${crossReason}`,
    );
  } finally {
    await p.dispose();
  }
});

test('a bare-name pick-list keeps every candidate, at any nesting depth, in any file', async () => {
  const p = await project(FILES);
  try {
    // The top-level preference exists to mirror the checker path's `name+file` contract, which is a
    // within-ONE-FILE rule. Applied across files it picks a FILE for a caller who pinned none — here, the
    // top-level `mixedDepth` over the nested one in another file, with the loser never mentioned. The
    // checker path is the oracle: it refuses.
    const checker = await sourceOf(p, { name: 'mixedDepth' }, false);
    assert.equal(checker.sources?.length ?? 0, 0, 'the checker path refuses (non-vacuous oracle)');

    const syn = await sourceOf(p, { name: 'mixedDepth' }, true);
    assert.equal(syn.sources?.length ?? 0, 0, 'the syntactic path must not silently pick a file');
    const reason = missReason(syn, 'mixed-depth cross-file');
    assert.match(reason, /in 2 files/, `states the file split: ${reason}`);
    assert.match(reason, /depth-top\.ts/, 'lists the top-level candidate');
    assert.match(reason, /depth-nested\.ts/, 'and the nested one — never dropped');

    // The SINGLE-FILE analogue, which is where the preference survives: what licenses ignoring a nested
    // candidate is the CALLER pinning a file, not the candidate set happening to sit in one. A bare name
    // pinned nothing, so picking the top-level here would choose a SCOPE for the caller and drop the other
    // candidate from every field — no `moreDefinitions`, no disclosure — while the op's note advertises
    // nested declarations as addressable.
    const oneFileChecker = await sourceOf(p, { name: 'soloDepth' }, false);
    assert.equal(
      oneFileChecker.sources?.length ?? 0,
      0,
      'the checker refuses (non-vacuous oracle)',
    );
    const oneFile = await sourceOf(p, { name: 'soloDepth' }, true);
    assert.equal(
      oneFile.sources?.length ?? 0,
      0,
      'a bare name must not pick a scope for the caller',
    );
    assert.equal(
      (missReason(oneFile, 'single-file mixed depth').match(/ts:soloDepth@/g) ?? []).length,
      2,
      'and both candidates are listed',
    );
    // …and the pin still licenses it: `name+file` resolves the top-level, as the checker path does. This
    // is the half that must NOT change, or the repair would have been a blanket deletion.
    const pinned = sole(
      await sourceOf(p, { name: 'soloDepth', file: 'src/depth-one.ts' }, true),
      'pin',
    );
    assert.match(
      pinned.decl.text,
      /export const soloDepth = 1;/,
      'a pinned file still prefers top-level',
    );

    // The bare-NAME arm specifically: every other rival arm addresses name+file, which routes through a
    // different resolver, so without this the bare-name pick-list has no arm of its own.
    const scoped = await sourceOf(p, { name: 'twin' }, true);
    assert.equal(scoped.sources?.length ?? 0, 0, 'a bare name over scope rivals refuses too');
    assert.equal(
      (missReason(scoped, 'bare-name rivals').match(/ts:twin@/g) ?? []).length,
      2,
      'and lists both candidates',
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
