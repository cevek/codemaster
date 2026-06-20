// Render-contract guard (the output-density umbrella, docs/backlog.md). `condense.ts`
// `collapseKnownShape` is an exact-key-set registry with a `return v` fall-through; a row shape
// with no case silently explodes into render-dense's multi-line `- key=value` block (watery). This
// test runs the at-risk ops over a real fixture and asserts NO result row falls through — so a
// future op (or a row-shape change) that lacks a collapse case fails CI here instead of shipping
// watery output. The oracle is structural: the precise fall-through signature, not "looks long".

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { project } from '../helpers/project.ts';
import { renderResult } from '../../src/format/render/render-result.ts';
import { summarizeQueryKey } from '../../src/format/render/condense.ts';
import { renderKey } from '../../src/ops/react-query-invalidations-for.ts';
import { tag } from '../../src/common/shape-tag/tag.ts';
import { fallThrough, leakedTag, renderRows, span, topLevelExplosion } from '../helpers/density.ts';
import type { QueryKeyView } from '../../src/plugins/react-query/views.ts';
import type { JsonValue } from '../../src/core/json.ts';
import type { Result } from '../../src/core/result.ts';
import type { OpResult } from '../../src/ops/contracts.ts';

function resultOf(r: OpResult): Result<JsonValue> {
  assert.ok('result' in r && r.result.ok, `op failed: ${JSON.stringify(r)}`);
  return r.result;
}

/** A fixture that triggers every at-risk TS-domain op with real, non-empty results: a type with
 *  a construction site, a dead export, and a component rendered from a second module (usages /
 *  importers / impact). No codemaster.config → ts (+ react autodetect) only; the i18n / scss /
 *  react-query ops carry their own collapse cases + tests (i18n-*.test.ts, react-query.test.ts). */
function fixture() {
  return project({
    'tsconfig.json':
      '{"compilerOptions":{"jsx":"react-jsx","strict":true,"module":"ESNext","moduleResolution":"Bundler"},"include":["src"]}',
    'src/types.ts':
      'export type Cfg = { a?: string; b?: number; nested?: { x: number } };\nexport const built: Cfg = { a: "x" };\n',
    'src/dead.ts': 'export const unusedThing = 1;\nexport type DeadType = { x: number };\n',
    'src/a.module.scss': '.used { color: red; }\n.dead { color: blue; }\n',
    'src/widget.tsx':
      "import s from './a.module.scss';\nexport function Widget({label}: {label: string}) {\n  return <button className={s.used}>{label}</button>;\n}\n",
    'src/app.tsx':
      'import {Widget} from "./widget.tsx";\nexport function App() {\n  return <Widget label="a" />;\n}\n',
  });
}

// op name → args, and the result field whose array must be non-empty (so the guard can never pass
// vacuously on an empty answer). Covers EVERY reachable read op across ts + scss (the config-gated
// i18n / react-query / schema / mutating shapes are exercised by TAG_SAMPLES below). Each row shape
// previously either fell through OR is a dense control.
const CASES: { name: string; args: JsonValue; rows: string }[] = [
  { name: 'construction_sites', args: { name: 'Cfg' }, rows: 'sites' },
  { name: 'find_unused_exports', args: {}, rows: 'unused' },
  { name: 'find_usages', args: { name: 'Widget' }, rows: 'usages' },
  { name: 'find_usages', args: { name: 'Widget', groupBy: 'enclosing' }, rows: 'enclosers' },
  { name: 'find_definition', args: { name: 'Widget' }, rows: 'definitions' },
  { name: 'expand_type', args: { name: 'Cfg', depth: 2 }, rows: 'members' },
  { name: 'search_symbol', args: { query: 'Widget' }, rows: 'matches' },
  { name: 'importers_of', args: { module: 'src/widget.tsx' }, rows: 'importers' },
  { name: 'impact', args: { name: 'Widget' }, rows: 'dependents' },
  { name: 'scss_classes', args: {}, rows: 'classes' },
  { name: 'find_unused_scss_classes', args: {}, rows: 'unused' },
  { name: 'css_cascade', args: { file: 'src/a.module.scss', class: 'used' }, rows: 'rules' },
];

test('no op result row falls through condense into a watery key=value block', async () => {
  const p = await fixture();
  try {
    for (const c of CASES) {
      const r = await p.op(c.name, c.args);
      const result = resultOf(r);
      const rows = (result.data as Record<string, JsonValue>)[c.rows];
      const count = Array.isArray(rows)
        ? rows.length
        : rows !== null && typeof rows === 'object'
          ? Object.keys(rows).length
          : 0;
      assert.ok(count > 0, `${c.name}: expected ≥1 row in '${c.rows}', got ${count} (vacuous)`);
      for (const verbosity of ['terse', 'normal'] as const) {
        const text = renderResult(result, verbosity);
        assert.equal(
          fallThrough(text),
          undefined,
          `${c.name} (${verbosity}) fell through condense → watery block:\n${fallThrough(text)}`,
        );
        assert.equal(
          topLevelExplosion(text),
          undefined,
          `${c.name} (${verbosity}) exploded a top-level nested object:\n${topLevelExplosion(text)}`,
        );
        assert.equal(
          leakedTag(text),
          undefined,
          `${c.name} (${verbosity}) leaked a shape tag:\n${leakedTag(text)}`,
        );
      }
      // The leaked-tag invariant holds at FULL too (a non-collapse row passes through with its tag
      // STRIPPED; a collapse-at-full row is consumed) — a tag must never reach the agent's output.
      assert.equal(
        leakedTag(renderResult(result, 'full')),
        undefined,
        `${c.name} (full) leaked a shape tag`,
      );
    }
  } finally {
    await p.dispose();
  }
});

// condense's `summarizeQueryKey` (text render) is an intentional structural twin of the op's
// `renderKey` (sql-table render) — the format layer can't import the react-query op/type, so the
// logic is duplicated. Cross-pin them so the duplication can never silently diverge (text and sql
// showing a different key for the same queryKey). Covers static / dynamic-segment / opaque keys.
test('summarizeQueryKey (text) == renderKey (sql) for every queryKey shape', () => {
  // Structural key literals — the per-segment/key `span` (a branded Span) is omitted and cast away:
  // neither renderer reads it, the comparison is purely over kind/value/shape/opaque.
  const keys = [
    { segments: [{ kind: 'static', value: 'todos' }], confidence: 'certain' },
    {
      segments: [
        { kind: 'static', value: 'todo' },
        { kind: 'dynamic', shape: 'identifier' },
      ],
      confidence: 'partial',
    },
    { segments: [], opaque: 'call', confidence: 'dynamic' },
  ];
  for (const k of keys) {
    assert.equal(
      summarizeQueryKey(k as unknown as JsonValue),
      renderKey(k as unknown as QueryKeyView, false),
      JSON.stringify(k),
    );
  }
});

// The shapes the pipeline fixture above can't reach without plugin config — a mutating-op `captures`
// refusal and `invalidations_for`'s react-query leaves — fed as literal rows through the SAME
// condense→dense path. Locks their collapse cases without needing a capture-triggering or
// react-query fixture.
test('captures + invalidations_for leaf shapes collapse to dense lines', () => {
  // mutating-op capture row { at, kind, detail } — must be one line, not a 3-line block.
  const cap = renderRows([
    tag('capture', { at: 'src/a.ts:1:1', kind: 'shadow', detail: 'rebinds to a local X' }),
  ]);
  assert.equal(fallThrough(cap), undefined, `captures fell through:\n${cap}`);
  // A row that collapses to a STRING renders bulletless (only object items get a `- ` bullet).
  assert.match(cap, /^src\/a\.ts:1:1 · shadow · rebinds to a local X$/m);

  // invalidations_for AffectedQuery { id, name, queryKey, site, confidence } — one line, key summarized.
  const affect = tag('rq-affected', {
    id: 'ts:useTodos@src/h.ts:1:1',
    name: 'useTodos',
    queryKey: {
      segments: [{ kind: 'static', value: 'todos' }],
      confidence: 'certain',
      span: span(2, 'todos'),
    },
    site: span(2, 'todos'),
    confidence: 'certain',
  });
  const aff = renderRows([affect]);
  assert.equal(fallThrough(aff), undefined, `affect fell through:\n${aff}`);
  assert.match(aff, /^ts:useTodos@src\/h\.ts:1:1 · \["todos"\]$/m);

  // invalidations_for edge — the scalar fan folds to one `edge=` line; affects stays a nested list.
  const edge = tag('rq-edge', {
    method: 'invalidate',
    key: {
      segments: [{ kind: 'static', value: 'todos' }],
      confidence: 'certain',
      span: span(3, 'todos'),
    },
    all: false,
    exact: false,
    narrowed: false,
    span: span(3, 'invalidateQueries'),
    affects: [affect],
  });
  const e = renderRows([edge]);
  assert.equal(fallThrough(e), undefined, `edge fell through:\n${e}`);
  assert.match(e, /- edge=invalidate @src\/h\.ts:3:1 \["todos"\] · certain/);
  assert.doesNotMatch(e, /\bmethod=|\ball=|\bnarrowed=/, 'edge scalar fields must not explode');
});

// A negative control: the predicate MUST fire on a genuinely exploded block, or the guard above is
// vacuous. This is the exact shape render-dense emits for an array of un-collapsed objects.
test('fallThrough predicate fires on a real exploded block (anti-vacuity)', () => {
  const exploded = [
    'sites (1):',
    '  - span=src/a.ts:1:1',
    '    confidence=certain',
    '    kind=function',
  ].join('\n');
  assert.notEqual(fallThrough(exploded), undefined, 'predicate failed to catch a known explosion');

  // …and catches the FIRST-FIELD-NESTED explosion (bullet is `- items (N):`, the exploded scalars
  // land at i+2+, never i+1 — the blind spot an `i+1`-only check missed). Uses the real render path
  // on an UNTAGGED object (a forgot-to-tag row), which is exactly what must explode.
  const firstNested = renderRows([{ items: [{ a: 1 }], confidence: 'certain', kind: 'function' }]);
  assert.notEqual(
    fallThrough(firstNested),
    undefined,
    `predicate missed a first-field-nested explosion:\n${firstNested}`,
  );

  // …and does NOT fire on a collapsed one-liner list, nor on a legit hierarchical row (nested arrays
  // only, no scalar pair — the invalidations_for `- id=…` → `edges (N):` → `affects` strings shape).
  const collapsed = ['sites (1):', '  - src/a.ts:1:1 · in ts:f@src/a.ts:1:1 (function)'].join('\n');
  assert.equal(fallThrough(collapsed), undefined, 'predicate false-positived on a collapsed row');
  const hierarchical = [
    'mutations (1):',
    '  - id=ts:useX@src/a.ts:1:1',
    '    edges (1):',
    '      - edge=invalidate @src/a.ts:2:1 ["x"] · certain',
    '        affects (1):',
    '          ts:useY@src/a.ts:3:1 · ["y"] · dynamic',
  ].join('\n');
  assert.equal(fallThrough(hierarchical), undefined, 'predicate false-positived on a legit tree');
});
