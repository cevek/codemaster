// 5a — registry COMPLETENESS, runtime (split from output-density.test.ts for the line cap).
// `SHAPE_RENDERERS` is a `Record<ShapeTag, …>` (compile-time exhaustive), but that does not prove
// each renderer COLLAPSES a real row. One representative row per tag is fed through the same
// condense→dense path; each must collapse with no leaked `~shape`, no explosion, and no
// `[object Object]` — at every verbosity, INCLUDING `full` for every `collapse`-disposition tag
// (all but the proof-bearing `symbol`). `full` is the load-bearing case: that is where a renderer
// that reaches a span via raw `String(v['span'])` meets a verbatim span OBJECT and prints
// `[object Object]` — an explosion-guard-invisible failure the `[object Object]` assertion catches.
// This reaches the config-gated shapes (i18n / react-query / schema / mutating / css) the live-op
// pipeline can't, so a new tag whose renderer is forgotten (or a sample omitted) fails CI here. A
// nested-row sample carries its children PRE-condensed (a string / [] ) — the row's OWN renderer is
// what's under test.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tag, type ShapeTag } from '../../src/common/shape-tag/tag.ts';
import { SHAPE_RENDERERS, FULL_DISPOSITION } from '../../src/format/render/shapes/index.ts';
import { fallThrough, leakedTag, renderRows, span } from '../helpers/density.ts';
import type { JsonValue } from '../../src/core/json.ts';
import type { Verbosity } from '../../src/core/result.ts';

const SAMPLE_SPAN = span(1, 'X');
const TAG_SAMPLES: Record<ShapeTag, Record<string, JsonValue>> = {
  symbol: { id: 'ts:X@a.ts:1:1', name: 'X', kind: 'function', span: SAMPLE_SPAN },
  usage: { span: SAMPLE_SPAN, role: 'call', confidence: 'certain' },
  'text-hit': { span: SAMPLE_SPAN, confidence: 'unresolved' },
  'group-row': {
    id: 'ts:X@a.ts:1:1',
    name: 'X',
    file: 'a.ts',
    line: 1,
    col: 1,
    kind: 'function',
    count: 2,
    roles: 'call',
    exported: true,
    confidence: 'certain',
    site: SAMPLE_SPAN,
  },
  importer: { at: 'a.ts:1', imports: 'X' },
  'subtree-importer': { at: 'a.ts:1', scope: 'external', target: 'src/dir/x.ts', imports: 'X' },
  'subtree-unconfirmed': { at: 'a.ts:1', spec: '../dir/x.scss', reason: 'spec did not resolve' },
  'construction-site': {
    span: SAMPLE_SPAN,
    confidence: 'partial',
    encloser: { id: 'ts:f@a.ts:1:1', kind: 'function', exported: true },
    note: 'generic target',
  },
  'unused-export': {
    symbol: 'ts:X@a.ts:1:1',
    kind: 'const',
    name: 'X',
    file: 'a.ts',
    span: SAMPLE_SPAN,
    confidence: 'partial',
    note: 'reached via a barrel',
  },
  'type-member': { name: 'x', optional: true, type: 'string | undefined' },
  'type-ref': { text: 'User', span: SAMPLE_SPAN, confidence: 'certain' },
  'unresolved-name': { name: 'X', reason: 'no symbol named X' },
  'bare-span': { span: SAMPLE_SPAN },
  'target-ref': { id: 'ts:X@a.ts:1:1', name: 'X', kind: 'function' },
  'ts-diagnostic': { file: 'a.ts', line: 1, message: 'Type X is not assignable\n  to Y.' },
  'parse-failure': { file: 'a.scss', message: 'unexpected }' },
  'typecheck-clean': { clean: true, preExisting: 12 },
  capture: { at: 'a.ts:1:1', kind: 'shadow', detail: 'rebinds to a local' },
  'name-survives': {
    summary: 'old name survives',
    reExportAliases: [SAMPLE_SPAN],
    exportStarConsumers: [],
  },
  'touched-stat': { path: 'src/a.ts', added: 3, removed: 1 },
  'i18n-unused-key': { key: 'a.b', file: 'en.json', span: SAMPLE_SPAN, confidence: 'partial' },
  'i18n-def': { key: 'a.b', locale: 'en', file: 'en.json', span: SAMPLE_SPAN, value: 'OK' },
  'i18n-usage': { key: 'a.b', span: SAMPLE_SPAN, provenance: 'written' },
  'i18n-missing-per-key': { key: 'a.b', missingLocales: ['ru'] },
  'i18n-missing-usage': { key: 'a.b', span: SAMPLE_SPAN, missingLocales: ['ru'] },
  'scss-class': { name: 'b', file: 'a.scss', span: SAMPLE_SPAN, confidence: 'certain' },
  'css-rule': {
    selector: '.b',
    specificity: '0,1,0',
    declarations: [{ prop: 'color', value: 'red', important: false }],
    span: SAMPLE_SPAN,
  },
  'css-property': { prop: 'color', winner: '[0,1,0] a.scss:1:1 · .b = red', losers: [] },
  'css-winner': {
    value: 'red',
    confidence: 'certain',
    selector: '.b',
    specificity: '0,1,0',
    span: SAMPLE_SPAN,
    important: false,
  },
  'css-decl-ref': { value: 'red', specificity: '0,1,0', selector: '.b', span: SAMPLE_SPAN },
  'css-left-behind': {
    class: 'c',
    code: 'NESTED',
    reason: 'in a nested selector',
    span: SAMPLE_SPAN,
  },
  'css-coextract': {
    sourceStylesheet: 'a.scss',
    targetStylesheet: 'b.scss',
    moved: ['x'],
    leftBehind: [],
  },
  'unused-prop': {
    name: 'size',
    optional: true,
    inherited: true,
    type: 'string',
    confidence: 'partial',
    span: SAMPLE_SPAN,
  },
  'rq-mutation': { id: 'ts:m@a.ts:1:1', name: 'm', site: SAMPLE_SPAN, edges: [] },
  'rq-edge': {
    method: 'invalidate',
    all: false,
    exact: false,
    narrowed: false,
    span: SAMPLE_SPAN,
    affects: [],
    key: { segments: [{ kind: 'static', value: 't' }], confidence: 'certain' },
  },
  'rq-affected': {
    id: 'ts:q@a.ts:1:1',
    name: 'q',
    queryKey: { segments: [{ kind: 'static', value: 't' }], confidence: 'certain' },
    site: SAMPLE_SPAN,
    confidence: 'certain',
  },
  'list-entry': {
    key: 'X',
    confidence: 'partial',
    file: 'a.ts',
    line: 1,
    col: 1,
    proof: SAMPLE_SPAN,
    kind: 'component',
    provenance: 'heuristic:react',
  },
  'endpoint-card': { method: 'GET', path: '/x', pathParams: [], confidence: 'certain' },
  'trace-hop': {
    from: { kind: 'mutation', label: 'm', key: 'ts:m@a.ts:1:1', span: SAMPLE_SPAN },
    to: { kind: 'queryKey', label: '["t"]', key: 'queryKey@a.ts:1:1', span: SAMPLE_SPAN },
    relation: 'invalidates',
    confidence: 'dynamic',
    provenance: { kind: 'heuristic', by: 'react-query' },
    note: 'broad invalidateQueries() with no key',
  },
};

test('every emitted shape tag has a renderer that collapses (no leak, no explosion)', () => {
  for (const t of Object.keys(SHAPE_RENDERERS) as ShapeTag[]) {
    const sample = TAG_SAMPLES[t];
    assert.ok(
      sample !== undefined,
      `no TAG_SAMPLES row for tag '${t}' — add one so the guard covers it`,
    );
    // `full` is asserted for every collapse-disposition tag — a verbatim tag (`symbol`) is the
    // opt-OUT: it legitimately passes its proof body through at full, so the explosion guard would
    // false-trip on it. terse/normal are asserted for ALL tags.
    const verbosities: Verbosity[] =
      FULL_DISPOSITION[t] === 'collapse' ? ['terse', 'normal', 'full'] : ['terse', 'normal'];
    for (const v of verbosities) {
      const text = renderRows([tag(t, sample)], v);
      assert.equal(leakedTag(text), undefined, `tag '${t}' (${v}) leaked into output:\n${text}`);
      assert.equal(fallThrough(text), undefined, `tag '${t}' (${v}) exploded:\n${text}`);
      // A renderer that String()s a span field collapses to one line but stringifies the verbatim
      // span OBJECT as `[object Object]` at full — invisible to the explosion guard. Catch it.
      assert.ok(
        !text.includes('[object Object]'),
        `tag '${t}' (${v}) stringified an object (missing spanLoc?):\n${text}`,
      );
    }
  }
});
