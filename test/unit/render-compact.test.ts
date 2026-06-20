// Compaction of the dense renderer (§12 "output is for agents — maximally compact"). Oracle:
// the rendered text must collapse known one-fact shapes to a SINGLE line and never repeat a
// path that the condensed span already carries. Each case pins a shape the live audit found
// bloated (scss lists, expand_type union members, find_definition:full).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderResult } from '../../src/format/render/render-result.ts';
import { ok } from '../../src/common/result/construct.ts';
import { tag } from '../../src/common/shape-tag/tag.ts';
import type { JsonValue } from '../../src/core/json.ts';

const span = (file: string, line: number, col: number, text: string): JsonValue => ({
  file,
  line,
  col,
  endLine: line,
  endCol: col + text.length,
  text,
});

test('scss class list collapses to one line per class (no duplicated file=)', () => {
  const out = renderResult(
    ok({
      classes: [
        tag('scss-class', {
          name: 'badge',
          file: 'a.module.scss',
          span: span('a.module.scss', 1, 1, '.badge'),
          confidence: 'certain',
        }),
      ],
    }),
  );
  assert.match(out, /a\.module\.scss:1:1 · badge/, 'one-liner: span · name');
  assert.doesNotMatch(out, /\n\s*file=/, 'no separate file= line (the span already carries it)');
  assert.doesNotMatch(out, /confidence=certain/, 'certain confidence stays implicit');
});

test('unused scss class surfaces non-certain confidence + note on the same line', () => {
  const out = renderResult(
    ok({
      unused: [
        tag('scss-class', {
          name: 'card',
          file: 'a.module.scss',
          span: span('a.module.scss', 5, 1, '.card'),
          confidence: 'partial',
          note: 'appears only in a contextual/compound/nested selector — cannot prove dead',
        }),
      ],
    }),
  );
  assert.match(
    out,
    /a\.module\.scss:5:1 · card · partial · appears only/,
    'span · name · conf · note, one line',
  );
});

// The strip-vs-surface invariant has TWO encloser shapes that must BOTH render terse, never
// fall through to a verbose key=value block: `find_usages` surfaces `site` (so a group is
// proof-carrying at the reference level), `impact` strips it. This is the CI backstop the
// invariant otherwise lacks — a future GroupRow emit path that leaks an unrecognized key set
// would flip one of these (the condense renderer only matches the two exact key sets).
test('grouped find_usages encloser row surfaces the reference `site` on the terse line', () => {
  const groupRow: JsonValue = tag('group-row', {
    id: 'ts:render@src/c.ts:3:3',
    name: 'Widget.render',
    file: 'src/c.ts',
    line: 3,
    col: 3,
    kind: 'method',
    count: 2,
    roles: 'call',
    exported: false,
    confidence: 'certain',
    site: span('src/c.ts', 4, 12, 'useX'),
  });
  const out = renderResult(ok({ enclosers: [groupRow] }));
  assert.match(
    out,
    /ts:render@src\/c\.ts:3:3 · method · x2 \(call\) · ref src\/c\.ts:4:12/,
    'terse one-liner WITH the ref site',
  );
  assert.doesNotMatch(out, /\n\s*site=/, 'site never leaks as a verbose key=value line');
  assert.doesNotMatch(out, /\n\s*id=/, 'the row stays collapsed, not a verbose block');
});

test('impact-style encloser row (site stripped) still renders terse, with NO ref segment', () => {
  const stripped: JsonValue = tag('group-row', {
    id: 'ts:render@src/c.ts:3:3',
    name: 'Widget.render',
    file: 'src/c.ts',
    line: 3,
    col: 3,
    kind: 'method',
    count: 2,
    roles: 'call',
    exported: false,
    confidence: 'certain',
  });
  const out = renderResult(ok({ dependents: { '1': [stripped] } }));
  assert.match(
    out,
    /ts:render@src\/c\.ts:3:3 · method · x2 \(call\)/,
    'terse one-liner, no verbose block',
  );
  assert.doesNotMatch(out, / · ref /, 'no ref segment when site was stripped');
  assert.doesNotMatch(
    out,
    /\n\s*id=/,
    'the row stays collapsed (the site-less key set still matches)',
  );
});

test('expand_type union member stays one line (name?: type), no 3-line explosion', () => {
  const out = renderResult(
    ok({
      about: 'interface X',
      span: span('t.ts', 1, 11, 'X'),
      members: [
        tag('type-member', { name: 'id', optional: false, type: 'string' }),
        tag('type-member', { name: 'awaiting', optional: true, type: 'string | undefined' }),
      ],
    }),
  );
  assert.match(out, /\n {2}id: string/, 'leaf member: name: type');
  assert.match(out, /\n {2}awaiting\?: string \| undefined/, 'optional union member on ONE line');
  assert.doesNotMatch(out, /\n\s*optional=/, 'no separate optional= line');
});

test('find_definition at full reuses the source body renderer (header + body, not exploded spans)', () => {
  const out = renderResult(
    ok({
      definitions: [
        {
          id: 'ts:Foo@a.ts:1:17',
          name: 'Foo',
          kind: 'function',
          span: span('a.ts', 1, 17, 'Foo'),
          decl: span('a.ts', 1, 1, 'export function Foo() {\n  return 1;\n}'),
          container: './a',
        },
      ],
    }),
    'full',
  );
  assert.match(out, /^ts:Foo@a\.ts:1:17 · function @ a\.ts:1:1/, 'source-style header line');
  assert.match(out, /export function Foo\(\) \{/, 'the verbatim body is shown');
  assert.doesNotMatch(out, /endLine=|endCol=/, 'no exploded span fields');
  assert.doesNotMatch(
    out,
    /container=/,
    'redundant container dropped (id already encodes the file)',
  );
});

test('find_definition:full carries the elided flag → truncation is stated, not a silent …', () => {
  // A decl body cut at the span cap (elided:true) MUST surface the "[body truncated …]" line —
  // dropping the flag in the source projection would present a cut body as complete (§3.4).
  const out = renderResult(
    ok({
      definitions: [
        {
          id: 'ts:Big@a.ts:1:17',
          name: 'Big',
          kind: 'function',
          span: span('a.ts', 1, 17, 'Big'),
          decl: {
            file: 'a.ts',
            line: 1,
            col: 1,
            endLine: 9,
            endCol: 1,
            text: 'export function Big() { /* huge … */',
            elided: true,
          },
        },
      ],
    }),
    'full',
  );
  assert.match(out, /\[body truncated at span cap/, 'truncation stated, never a bare …');
});

test('find_definition at NORMAL: one-liner + decl header, not a multi-line key=value block', () => {
  const out = renderResult(
    ok({
      definitions: [
        tag('symbol', {
          id: 'ts:useAppForm@src/lib/form.tsx:307:17',
          name: 'useAppForm',
          kind: 'function',
          span: span('src/lib/form.tsx', 307, 17, 'useAppForm'),
          decl: span('src/lib/form.tsx', 307, 1, 'export function useAppForm<T>(o: O): Form {'),
          container: '"./form"',
        }),
      ],
    }),
    'normal',
  );
  assert.match(
    out,
    /ts:useAppForm@src\/lib\/form\.tsx:307:17 · function in "\.\/form"/,
    'header line',
  );
  assert.match(out, /\n\s+export function useAppForm</, 'decl header on a continuation line');
  assert.doesNotMatch(out, /\n\s*name=/, 'no redundant name= field (it is in the id)');
  assert.doesNotMatch(out, /\n\s*span=/, 'no redundant name-token span= field');
  assert.doesNotMatch(out, /\n\s*container=/, 'container folded into the header, not a field');
});

test('find_definition:full with empty definitions renders the dense "(0)" marker, not a blank', () => {
  const out = renderResult(ok({ definitions: [] }), 'full');
  assert.match(out, /definitions \(0\)/, 'explicit 0, never an empty render');
});

test('i18n unused key is one line (span · key · conf); the demote reason is stated ONCE', () => {
  const out = renderResult(
    ok({
      unused: [
        tag('i18n-unused-key', {
          key: 'errors.x',
          file: 'locales/en.json',
          span: span('locales/en.json', 5, 9, '"X"'),
          confidence: 'partial',
        }),
      ],
      degraded: true,
      degradedReason: 'cannot prove dead — a dynamic t(`…`) call exists',
      scanned: { keys: 1, usages: 0 },
    }),
  );
  assert.match(out, /locales\/en\.json:5:9 · errors\.x · partial/, 'one-liner row');
  assert.doesNotMatch(out, /\n\s*file=/, 'no separate file= line');
  // The reason rides ONCE on the envelope, not on every row.
  assert.match(out, /degradedReason=cannot prove dead/, 'reason stated once');
  assert.equal((out.match(/cannot prove dead/g) ?? []).length, 1, 'reason appears exactly once');
});

test('i18n_lookup defs / usages / missing-per-key each collapse to one line', () => {
  const out = renderResult(
    ok({
      defs: [
        tag('i18n-def', {
          key: 'common.ok',
          locale: 'en',
          file: 'locales/en.json',
          span: span('locales/en.json', 12, 9, '"OK"'),
          value: 'OK',
        }),
      ],
      usages: [
        tag('i18n-usage', { key: 'common.ok', span: span('src/a.ts', 3, 10, "t('common.ok')") }),
      ],
      missingPerKey: [tag('i18n-missing-per-key', { key: 'common.ok', missingLocales: ['ru'] })],
      locales: ['en', 'ru'],
      matched: 1,
    }),
  );
  assert.match(out, /locales\/en\.json:12:9 · common\.ok · en=OK/, 'KeyDef one-liner');
  assert.match(out, /src\/a\.ts:3:10 · common\.ok/, 'usage one-liner');
  assert.match(out, /common\.ok · missing in \[ru\]/, 'missing-per-key one-liner');
  assert.doesNotMatch(out, /\n\s*locale=/, 'no exploded locale= line');
});

test('find_missing folds the missing locales into ONE row; dynamicUsages are bare locations', () => {
  const out = renderResult(
    ok({
      missing: [
        tag('i18n-missing-usage', {
          key: 'common.ghost',
          span: span('src/a.ts', 4, 24, "t('common.ghost')"),
          missingLocales: ['de', 'en', 'ru'],
        }),
      ],
      locales: ['de', 'en', 'ru'],
      dynamicUsages: [tag('bare-span', { span: span('src/a.ts', 5, 22, 't(`x`)') })],
    }),
  );
  assert.match(
    out,
    /src\/a\.ts:4:24 · common\.ghost · missing in \[de,en,ru\]/,
    'one row, locales folded in (never a row per locale)',
  );
  assert.match(out, /src\/a\.ts:5:22/, 'dynamicUsages location present');
  assert.doesNotMatch(out, /span=/, 'dynamicUsages render as a bare location, no span= prefix');
});
