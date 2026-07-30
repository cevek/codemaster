// t-229522 — the honesty gate for `source { syntactic: true }`: a declaration BODY read off the
// no-program AST surface must be the SAME BYTES the checker path returns for the same declaration.
//
// The oracle is the CHECKER PATH ITSELF (`source` without the flag). That is a real independent oracle,
// not a circular one: the two share no resolution logic — the default path resolves through the LS
// (`getDefinitionAtPosition` over a built program, walking up from an offset), this one indexes
// `getNamedDeclarations` over a `ts.createSourceFile` surface with no program at all. A byte-equality
// between them is therefore a claim about the world, not about one implementation agreeing with itself.
//
// This half holds the invariants of a SUCCESSFUL answer; what the path REFUSES, and why, is
// `syntactic-source-boundaries.test.ts`. Both drive the one shared fixture
// (`test/helpers/syntactic-source-fixture.ts`) so they reason about the same declarations.
//
//  1. all FIVE addressings agree with each other AND with the checker path, byte for byte — so an
//     agent that switches the flag, or re-addresses the same symbol, reads the same declaration;
//  2. the path builds NO program (the ts plugin stays cold) — the mechanism the whole feature rests on;
//  3. it answers in a BATCH beside a failing neighbour (the field failure was a `source` killed as a
//     passenger of a heavy batch neighbour; this is the hermetically testable half of that);
//  4. the scope/provenance statement is on every answer, in the rendered TEXT as well as the data
//     (a renderer that prints only the fields it knows drops the honesty channel silently).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { project, assertSpansValid } from '../helpers/project.ts';
import { renderResult } from '../../src/format/render/render-result.ts';
import type { JsonValue } from '../../src/core/json.ts';
import {
  SYNTACTIC_FIXTURE as FILES,
  sole,
  sourceOf,
  type SourceData,
} from '../helpers/syntactic-source-fixture.ts';

test('syntactic source == checker source, byte for byte, across all five addressings', async () => {
  const p = await project(FILES);
  try {
    // Each symbol addressed by name+file first — the form both paths resolve identically — to learn
    // its real position, then re-addressed every other way. The position is READ, never hard-coded, so
    // the test survives an edit to the fixture above and cannot silently assert about the wrong line.
    for (const name of ['WidgetProps', 'makeWidget', 'WidgetLimit', 'WidgetBase']) {
      const checker = sole(
        await sourceOf(p, { name, file: 'src/widget.ts' }, false),
        `${name}/ref`,
      );
      assert.ok(checker.decl.text.includes(name), `oracle body for ${name} is non-vacuous`);
      const { line, col } = checker.decl;
      // The name-token position (the id's own line:col), which is what a handle records — distinct
      // from the declaration START above (`export const X` starts a column earlier).
      const idPos = /@[^@]*:(\d+):(\d+)/.exec(checker.id);
      assert.ok(idPos !== null, `oracle id carries a position: ${checker.id}`);
      const nameLine = Number(idPos[1]);
      const nameCol = Number(idPos[2]);

      const addressings: Array<[string, Record<string, JsonValue>]> = [
        ['name', { name }],
        ['name+file', { name, file: 'src/widget.ts' }],
        ['file+line', { file: 'src/widget.ts', line: nameLine }],
        ['file+line+col', { file: 'src/widget.ts', line: nameLine, col: nameCol }],
        ['symbolId', { symbolId: checker.id }],
      ];
      for (const [label, target] of addressings) {
        const syn = sole(await sourceOf(p, target, true), `${name} via ${label}`);
        assert.equal(
          syn.decl.text,
          checker.decl.text,
          `${name} via ${label}: syntactic body must equal the checker's, byte for byte`,
        );
        assert.equal(syn.decl.line, line, `${name} via ${label}: same declaration start line`);
        assert.equal(syn.decl.col, col, `${name} via ${label}: same declaration start column`);
        assert.equal(syn.provenance, 'syntactic', `${name} via ${label}: provenance stated`);
      }
    }
  } finally {
    await p.dispose();
  }
});

test('syntactic source builds NO program (the ts plugin stays cold) + spans valid', async () => {
  const p = await project(FILES);
  try {
    const res = await p.op('source', {
      name: 'makeWidget',
      file: 'src/widget.ts',
      syntactic: true,
    });
    assert.ok('result' in res && res.result.ok, 'syntactic source ok');
    assert.ok(assertSpansValid(p.root, res) > 0, 'every proof span is valid (§16 inv.1)');

    const cold = await p.orchestrator.status(p.root, p.root);
    assert.equal(
      cold.workspace?.plugins.find((x) => x.id === 'ts')?.fingerprint,
      'cold',
      'the syntactic path must NOT warm the LS / build a program',
    );

    // Contrast: the DEFAULT path warms it — which is what makes the assertion above discriminating
    // (and what makes a checker `source` sharing a batch's heap vulnerable to its neighbours).
    await p.op('source', { name: 'makeWidget', file: 'src/widget.ts' });
    const warm = await p.orchestrator.status(p.root, p.root);
    assert.notEqual(
      warm.workspace?.plugins.find((x) => x.id === 'ts')?.fingerprint,
      'cold',
      'the default (checker) path warms the LS',
    );
  } finally {
    await p.dispose();
  }
});

test('syntactic source answers in a batch beside a FAILING neighbour', async () => {
  const p = await project(FILES);
  try {
    // The measured field failure was a `source` killed as a PASSENGER of a heavy batch neighbour. A
    // hermetic fixture cannot reproduce an OOM, but it can prove the weaker half that is testable:
    // a neighbour's failure never propagates into this call, and this call needs nothing the
    // neighbour was building.
    const results = await p.request([
      { name: 'find_definition', args: { name: 'NoSuchSymbolAtAll' } },
      { name: 'source', args: { name: 'makeWidget', file: 'src/widget.ts', syntactic: true } },
    ]);
    const [neighbour, mine] = results;
    assert.ok(neighbour !== undefined && 'result' in neighbour);
    assert.equal(neighbour.result.ok, false, 'the neighbour really did fail (non-vacuous)');
    assert.ok(
      mine !== undefined && 'result' in mine && mine.result.ok,
      'the syntactic read answered',
    );
    assert.ok(
      sole(mine.result.data as SourceData, 'batch').decl.text.includes('makeWidget'),
      'and it answered with the body, not an empty shell',
    );
  } finally {
    await p.dispose();
  }
});

test('the scope/provenance statement survives into the RENDERED text, not just the data', async () => {
  const p = await project(FILES);
  try {
    const res = await p.op('source', {
      name: 'makeWidget',
      file: 'src/widget.ts',
      syntactic: true,
    });
    assert.ok('result' in res && res.result.ok);
    assert.match(
      String((res.result.data as SourceData).note),
      /under the workspace root/i,
      'the data carries the scope',
    );
    // The load-bearing half: `renderSource` emits only the keys it knows, so a `note` it does not read
    // is dropped with no trace — the answer would then read as type-verified in the DEFAULT mode.
    for (const verbosity of ['terse', 'normal', 'full'] as const) {
      const text = renderResult(res.result, verbosity);
      assert.match(
        text,
        /no type-check/i,
        `${verbosity}: the rendered text states it is syntactic`,
      );
      assert.match(
        text,
        /OUTSIDE the root/i,
        `${verbosity}: the rendered text states the scope gap`,
      );
      assert.ok(text.includes('makeWidget'), `${verbosity}: and still shows the body`);
    }
  } finally {
    await p.dispose();
  }
});
