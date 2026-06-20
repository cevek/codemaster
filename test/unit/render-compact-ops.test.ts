// Compaction of the dense renderer (§12) — op-shape one-liners that the live audit found rendering
// as multi-line key=value blocks: mutating-op typecheck diagnostics, schema EndpointCard + TypeRef,
// find_usages `unresolved`, and extract_symbol cssCoExtract `leftBehind`. Sibling of
// render-compact.test.ts (split only to stay under the 300-line file cap).

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

test('mutating-op typecheck diagnostics collapse to one line each (file:line · message)', () => {
  const out = renderResult(
    ok({
      mode: 'dry-run',
      typecheck: {
        clean: false,
        introduced: [
          tag('ts-diagnostic', {
            file: 'src/a.tsx',
            line: 101,
            message: "Parameter 'result' implicitly has an 'any' type.",
          }),
          tag('ts-diagnostic', {
            file: 'src/b.tsx',
            line: 13,
            message: 'Type X is not assignable\n  to type Y.',
          }),
        ],
        preExisting: 600,
      },
    }),
  );
  assert.match(
    out,
    /src\/a\.tsx:101 · Parameter 'result' implicitly has an 'any' type\./,
    'diagnostic one-liner: file:line · message',
  );
  assert.match(out, /src\/b\.tsx:13 · Type X is not assignable to type Y\./, 'message flattened');
  assert.doesNotMatch(out, /\n\s*file=/, 'no exploded file= line');
  assert.doesNotMatch(out, /\n\s*message=/, 'no exploded message= line');
});

test('schema EndpointCard + nested TypeRef collapse to one line each', () => {
  const out = renderResult(
    ok({
      endpoints: [
        tag('endpoint-card', {
          method: 'GET',
          path: '/users/{id}',
          pathParams: ['id'],
          query: tag('type-ref', {
            text: '{ q?: string }',
            span: span('openapi.d.ts', 10, 5, 'query'),
            confidence: 'certain',
          }),
          response: tag('type-ref', {
            text: 'User',
            span: span('openapi.d.ts', 12, 5, 'response'),
            confidence: 'certain',
          }),
          status: 200,
          span: span('openapi.d.ts', 9, 3, 'get'),
          confidence: 'certain',
        }),
      ],
      total: 1,
    }),
  );
  assert.match(out, /GET \/users\/\{id\} →200/, 'endpoint method/path/status one-liner');
  assert.match(out, /q=\{ q\?: string \}/, 'query TypeRef folded in (type only, span stripped)');
  assert.match(out, /resp=User/, 'response TypeRef folded in');
  assert.doesNotMatch(out, /\n\s*method=/, 'no exploded method= block');
  assert.doesNotMatch(out, /\n\s*pathParams/, 'pathParams not a separate sub-list');
});

test('find_usages unresolved row collapses to name · reason', () => {
  const out = renderResult(
    ok({
      targets: [],
      unresolved: [tag('unresolved-name', { name: 'Nope', reason: 'no symbol named Nope' })],
    }),
  );
  assert.match(out, /Nope · no symbol named Nope/, 'unresolved one-liner');
  assert.doesNotMatch(out, /\n\s*reason=/, 'no exploded reason= line');
});

test('find_usages text-only rows render as bare locations; `unresolved` stated once in the note', () => {
  const out = renderResult(
    ok({
      usages: [
        tag('usage', { span: span('src/a.ts', 2, 5, 'foo'), role: 'read', confidence: 'certain' }),
      ],
      total: 1,
      textOnly: [
        tag('text-hit', { span: span('src/a.ts', 1, 4, 'foo'), confidence: 'unresolved' }),
        tag('text-hit', { span: span('README.md', 3, 1, 'foo'), confidence: 'unresolved' }),
      ],
      notes: [
        'text-only (same text — identity NOT proven): 2 occurrence(s) in comments/strings/docs',
      ],
    }),
  );
  // Each text-only row is just its clickable location — no per-row `· unresolved` repeat (the whole
  // section is identity-unproven by definition; the caveat + count ride the section note ONCE).
  assert.match(out, /src\/a\.ts:1:4/, 'text-only row is a bare loc');
  assert.match(out, /README\.md:3:1/, 'second text-only row present');
  assert.doesNotMatch(out, /· unresolved/, 'no per-row unresolved confidence');
  assert.match(out, /identity NOT proven\): 2 occurrence\(s\)/, 'count + caveat in the note, once');
});

test('a single-role-filtered usage row drops its role (it rides the hoisted header)', () => {
  // The op hoists `role` to a top-level field and strips it per-row; the renderer must then NOT
  // print a trailing `· undefined`. (Mirror of the find_usages role-hoist data change.)
  const out = renderResult(
    ok({
      role: 'jsx',
      usages: [
        tag('usage', { span: span('src/a.tsx', 5, 7, 'X'), confidence: 'certain' }),
        tag('usage', { span: span('src/b.tsx', 9, 3, 'X'), confidence: 'certain' }),
      ],
      total: 2,
    }),
  );
  assert.match(out, /role=jsx/, 'the pinned role is a header field');
  assert.match(out, /src\/a\.tsx:5:7$/m, 'a row with no role renders as just its location');
  assert.doesNotMatch(out, /· undefined/, 'never a `· undefined` from a missing role');
});

test('extract cssCoExtract leftBehind row collapses to one line', () => {
  const out = renderResult(
    ok({
      cssCoExtract: [
        tag('css-coextract', {
          sourceStylesheet: 'a.scss',
          targetStylesheet: 'b.scss',
          moved: ['x'],
          leftBehind: [
            tag('css-left-behind', {
              class: 'card',
              code: 'NESTED',
              reason: 'appears in a nested selector',
              span: span('a.scss', 3, 1, '.card'),
            }),
          ],
        }),
      ],
    }),
  );
  assert.match(
    out,
    /a\.scss:3:1 · card · NESTED · appears in a nested selector/,
    'leftBehind one-liner',
  );
  assert.doesNotMatch(out, /\n\s*code=/, 'no exploded code= line');
});

test('§3a: the typecheck/touched verdict survives the output cap; only the diff is truncated', () => {
  // A big mutation diff exceeds RENDER_CHAR_CAP (20k). Because `diff` is the LAST key, the verdict
  // (typecheck + touched) renders first and stays intact; the cap truncates only the diff — the
  // agent always learns whether the edit is safe (spec-stresstest §3a). Before the fix the diff led
  // and buried the verdict past `!! OUTPUT CAPPED`.
  const hugeDiff = Array.from(
    { length: 4000 },
    (_, i) => `+ line ${i} of a very large unified diff`,
  ).join('\n');
  const out = renderResult(
    ok({
      mode: 'dry-run',
      typecheck: { clean: true, preExisting: 12 },
      touched: ['src/a.ts', 'src/b.ts'],
      diff: hugeDiff,
    } as JsonValue),
  );
  assert.match(
    out,
    /!! OUTPUT CAPPED/,
    'guard: the diff must actually bust the cap for this test to mean anything',
  );
  const verdictAt = out.indexOf('preExisting=12');
  const cappedAt = out.indexOf('!! OUTPUT CAPPED');
  assert.ok(verdictAt >= 0, 'the typecheck verdict must be present in the capped output');
  assert.ok(
    verdictAt < cappedAt,
    'the verdict must render BEFORE the cap marker, never be buried by the diff',
  );
  assert.match(
    out.slice(0, cappedAt),
    /touched \(2\)/,
    'the touched summary must survive the cap too',
  );
});

test('list registry entries collapse to one clickable line each (key · kind · loc · confidence · provenance)', () => {
  const entry = (name: string, file: string, line: number, confidence: string): JsonValue =>
    tag('list-entry', {
      key: name,
      kind: 'component',
      confidence,
      provenance: 'heuristic:react',
      file,
      line,
      col: 17,
      name,
      proof: span(file, line, 17, name),
    });
  const out = renderResult(
    ok({
      registry: 'components',
      found: true,
      owner: 'react',
      entries: [
        entry(
          'ToolButton',
          'dev-recorder/src/RecorderPanel/ToolButton/ToolButton.tsx',
          17,
          'certain',
        ),
        entry('DevRecorder', 'src/DevRecorder.tsx', 43, 'partial'),
      ],
    }),
  );
  // Each entry is ONE line; no exploded key=value fields, no redundant proof= / name= repetition.
  assert.match(
    out,
    /ToolButton · component · dev-recorder\/src\/RecorderPanel\/ToolButton\/ToolButton\.tsx:17:17 · heuristic:react/,
    'a certain entry renders as one line, confidence implicit',
  );
  assert.match(
    out,
    /DevRecorder · component · src\/DevRecorder\.tsx:43:17 · partial · heuristic:react/,
    'a partial entry surfaces its confidence inline',
  );
  assert.doesNotMatch(out, /\n\s+proof=/, 'no redundant proof= line (file:line:col already shown)');
  assert.doesNotMatch(out, /\n\s+name=ToolButton/, 'no redundant name= line (key already shown)');
  assert.doesNotMatch(out, /\n\s+col=17/, 'no exploded col= field line');
});
