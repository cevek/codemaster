// t-229522 — the honesty gate for `source { syntactic: true }`: a declaration BODY read off the
// no-program AST surface must be the SAME BYTES the checker path returns for the same declaration, and
// where the two paths genuinely differ it must say so instead of substituting something plausible.
//
// The oracle is the CHECKER PATH ITSELF (`source` without the flag). That is a real independent oracle,
// not a circular one: the two share no resolution logic — the default path resolves through the LS
// (`getDefinitionAtPosition` over a built program, walking up from an offset), this one indexes
// `getNamedDeclarations` over a `ts.createSourceFile` surface with no program at all. A byte-equality
// between them is therefore a claim about the world, not about one implementation agreeing with itself.
//
// Five assertions, each guarding a distinct lie:
//  1. all FIVE addressings agree with each other AND with the checker path, byte for byte — so an
//     agent that switches the flag, or re-addresses the same symbol, reads the same declaration;
//  2. the path builds NO program (the ts plugin stays cold) — the mechanism the whole feature rests on;
//  3. an ALIAS address (an import/re-export site — exactly what `search_symbol {syntactic:true}` mints
//     handles for) is an explicit miss, never an `import` line printed as the symbol's body;
//  4. a REFERENCE position, which the checker path follows into another file, is an explicit miss —
//     never the enclosing declaration served in its place;
//  5. the scope/provenance statement is on every answer, in the rendered TEXT as well as the data
//     (a renderer that prints only the fields it knows drops the honesty channel silently).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { project, assertSpansValid, type TestProject } from '../helpers/project.ts';
import { renderResult } from '../../src/format/render/render-result.ts';
import type { JsonValue } from '../../src/core/json.ts';

// One top-level symbol per addressable kind, plus the two shapes that must NOT print a body: an
// aliased re-import of a symbol declared elsewhere, and a reference to it.
const FILES: Record<string, string> = {
  'tsconfig.json':
    '{"compilerOptions":{"strict":true,"module":"nodenext","moduleResolution":"nodenext"}}',
  'src/widget.ts': [
    'export interface WidgetProps {',
    '  size: string;',
    '}',
    'export function makeWidget(p: WidgetProps) {',
    '  return { size: p.size };',
    '}',
    'export const WidgetLimit = 42;',
    'export class WidgetBase {',
    '  ping() { return 1; }',
    '}',
  ].join('\n'),
  'src/app.ts': [
    'import { makeWidget as build, WidgetLimit } from "./widget.ts";',
    'export const useWidget = () => build({ size: String(WidgetLimit) });',
  ].join('\n'),
};

type SourceEntry = {
  id: string;
  name: string;
  kind: string;
  decl: { file: string; line: number; col: number; text: string };
  provenance?: string;
};
type SourceData = {
  note?: string;
  sources?: SourceEntry[];
  unresolved?: { target: string; reason: string }[];
};

async function sourceOf(
  p: TestProject,
  target: Record<string, JsonValue>,
  syntactic: boolean,
): Promise<SourceData> {
  const res = await p.op('source', { ...target, ...(syntactic ? { syntactic: true } : {}) });
  assert.ok('result' in res, `dispatch for ${JSON.stringify(target)}`);
  assert.ok(res.result.ok, `source ${JSON.stringify(target)} ok: ${JSON.stringify(res.result)}`);
  return res.result.data as SourceData;
}

/** The one entry a single-target call must have produced. */
function sole(data: SourceData, label: string): SourceEntry {
  const entry = data.sources?.[0];
  assert.ok(
    entry !== undefined,
    `${label}: expected a body, got unresolved: ${JSON.stringify(data.unresolved)}`,
  );
  return entry;
}

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
    const reason = data.unresolved?.[0]?.reason ?? '';
    assert.match(reason, /import \/ re-export re-mention/i, 'says WHAT the address holds');
    assert.match(reason, /no module specifier/i, 'says why it cannot follow it');
    assert.ok(!reason.includes('import { makeWidget'), 'and never quotes the import as the body');
  } finally {
    await p.dispose();
  }
});

test('a REFERENCE position the checker path follows is an explicit miss here', async () => {
  const p = await project(FILES);
  try {
    // `build({...})` in app.ts line 2 — a call through an import alias. The oracle: the checker path
    // FOLLOWS it into widget.ts. Without that arm this test would pass even if the syntactic path
    // silently printed the enclosing `useWidget`.
    const col = FILES['src/app.ts']?.split('\n')[1]?.indexOf('build(') ?? -1;
    assert.ok(col >= 0, 'fixture still contains the aliased call');
    const at = { file: 'src/app.ts', line: 2, col: col + 1 };

    const followed = sole(await sourceOf(p, at, false), 'checker at a reference');
    assert.match(
      followed.decl.file,
      /widget\.ts$/,
      'the checker path resolves it to the DECLARATION',
    );

    const data = await sourceOf(p, at, true);
    assert.equal(data.sources?.length ?? 0, 0, 'the syntactic path prints nothing there');
    const reason = data.unresolved?.[0]?.reason ?? '';
    assert.match(reason, /cannot follow a reference/i, 'states the capability boundary');
    assert.ok(!reason.includes('useWidget'), 'and never offers the enclosing declaration instead');
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
