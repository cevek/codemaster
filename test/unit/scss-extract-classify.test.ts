// Stage 1 oracle (spec-css-coextract §2.7): one fixture per leave-behind code, plus the
// safe cases, asserted against an INDEPENDENT hand-classification (the expected verdict is
// written next to each fixture, not derived from the code under test). Read-only taxonomy.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseStylesheetRoot } from '../../src/plugins/scss/parse-root.ts';
import {
  classifyForExtract,
  selectorIsOwnedBy,
  type ClassVerdict,
} from '../../src/plugins/scss/extract-classify.ts';

function classify(
  source: string,
  classNames: string[],
  usedInRemaining: Set<string> = new Set(),
  file = 'x.module.scss',
): Map<string, ClassVerdict> {
  const parsed = parseStylesheetRoot(source, file);
  assert.ok(parsed.ok, `fixture must parse: ${parsed.ok ? '' : parsed.message}`);
  return classifyForExtract(parsed.root, classNames, usedInRemaining);
}

function code(v: ClassVerdict | undefined): string {
  assert.ok(v !== undefined, 'class must have a verdict');
  return v.kind === 'safe' ? 'safe' : v.code;
}

test('safe: a clean owned rule (and chained pseudos) moves', () => {
  const v = classify('.card { color: red; }\n.title:hover::before { content: ""; }', [
    'card',
    'title',
  ]);
  assert.equal(code(v.get('card')), 'safe');
  assert.equal(code(v.get('title')), 'safe');
});

test('USED: a class the remaining source still references stays', () => {
  const v = classify('.card { color: red; }', ['card'], new Set(['card']));
  assert.equal(code(v.get('card')), 'USED');
});

test('NO-RULE: a referenced class with no owning rule stays', () => {
  const v = classify('.other { color: red; }', ['ghost']);
  assert.equal(code(v.get('ghost')), 'NO-RULE');
});

test('COMPOUND: a class entangled in a compound/descendant selector stays', () => {
  const compound = classify('.card { color: red; }\n.card.active { color: blue; }', ['card']);
  assert.equal(code(compound.get('card')), 'COMPOUND');
  const descendant = classify('.card { color: red; }\n.wrap .card { color: blue; }', ['card']);
  assert.equal(code(descendant.get('card')), 'COMPOUND');
});

test('NESTED: an owning rule with nested child rules stays', () => {
  const v = classify('.card {\n  color: red;\n  .inner { color: blue; }\n}', ['card']);
  assert.equal(code(v.get('card')), 'NESTED');
});

test('NEST-PARENT: an owning rule nested inside another selector stays', () => {
  const v = classify('.wrap {\n  .card { color: red; }\n}', ['card']);
  assert.equal(code(v.get('card')), 'NEST-PARENT');
});

test('AT-RULE: an owning rule body using an unsafe at-rule stays (with detail)', () => {
  const v = classify('.card {\n  @include shadow();\n  color: red;\n}', ['card']);
  const verdict = v.get('card');
  assert.ok(verdict !== undefined && verdict.kind === 'left');
  assert.equal(verdict.code, 'AT-RULE');
  assert.equal(verdict.detail, '@include');
});

test('SASS-VAR: a declaration referencing a Sass variable stays', () => {
  const v = classify('$brand: #00f;\n.card { color: $brand; }', ['card']);
  assert.equal(code(v.get('card')), 'SASS-VAR');
});

test('SASS-VAR: a Sass variable in an interpolated property name stays', () => {
  const v = classify('.card { #{$prop}: red; }', ['card']);
  assert.equal(code(v.get('card')), 'SASS-VAR');
});

test('AT-RULE: an unsafe at-rule NESTED inside @media (not a direct child) is still caught', () => {
  const v = classify(
    '.card {\n  color: red;\n  @media (min-width: 1px) { @include shadow(); }\n}',
    ['card'],
  );
  const verdict = v.get('card');
  assert.ok(verdict !== undefined && verdict.kind === 'left');
  assert.equal(verdict.code, 'AT-RULE');
});

test('NESTED: a child rule nested inside @media (not a direct child) is still caught', () => {
  const v = classify('.card {\n  @media (min-width: 1px) { .inner { color: red; } }\n}', ['card']);
  assert.equal(code(v.get('card')), 'NESTED');
});

test('safe: @media wrapping only declarations is self-contained and moves', () => {
  const v = classify('.card {\n  @media (min-width: 1px) { color: red; }\n}', ['card']);
  assert.equal(code(v.get('card')), 'safe');
});

test('EXTEND: a class @extended elsewhere stays', () => {
  const v = classify('.card { color: red; }\n.promo { @extend .card; }', ['card']);
  assert.equal(code(v.get('card')), 'EXTEND');
});

test('EXTEND: tolerant of !optional and comma lists', () => {
  const opt = classify('.card { color: red; }\n.promo { @extend .card !optional; }', ['card']);
  assert.equal(code(opt.get('card')), 'EXTEND');
  const list = classify('.card { color: red; }\n.promo { @extend .card, .other; }', ['card']);
  assert.equal(code(list.get('card')), 'EXTEND');
});

test('COMPOSES: a rule that composes another class stays', () => {
  const v = classify('.base { color: red; }\n.card { composes: base; font-weight: bold; }', [
    'card',
  ]);
  assert.equal(code(v.get('card')), 'COMPOSES');
});

test('COMPOSES: a class composed BY another rule stays', () => {
  const v = classify('.card { color: red; }\n.promo { composes: card; }', ['card']);
  assert.equal(code(v.get('card')), 'COMPOSES');
});

test('KEYFRAMES: a rule animating a @keyframes defined in this sheet stays', () => {
  const src =
    '@keyframes spin { from { opacity: 0; } to { opacity: 1; } }\n.card { animation: spin 1s; }';
  const v = classify(src, ['card']);
  assert.equal(code(v.get('card')), 'KEYFRAMES');
});

test('safe: an animation referencing a keyframe NOT defined in this sheet still moves', () => {
  // No local @keyframes named `spin` → not a scoped-name hazard → safe.
  const v = classify('.card { animation: spin 1s; }', ['card']);
  assert.equal(code(v.get('card')), 'safe');
});

test('owns only when EVERY branch of a selector list is owned', () => {
  assert.equal(selectorIsOwnedBy('.card', 'card'), true);
  assert.equal(selectorIsOwnedBy('.card:hover, .card:focus', 'card'), true);
  assert.equal(selectorIsOwnedBy('.card:nth-child(2n+1)', 'card'), true); // non-selector pseudo arg
  assert.equal(selectorIsOwnedBy('.card, .other', 'card'), false); // mixed-owner list
  assert.equal(selectorIsOwnedBy('.card.modifier', 'card'), false); // compound
  assert.equal(selectorIsOwnedBy('.cardish', 'card'), false); // prefix, not the class
  // A pseudo arg holding a class is a dependency on it → NOT owned (would break on move).
  assert.equal(selectorIsOwnedBy('.card:not(.disabled)', 'card'), false);
  assert.equal(selectorIsOwnedBy('.card:has(.icon)', 'card'), false);
});

test('a class whose owning rule references another class via :not() stays (not false-safe)', () => {
  // `.card:not(.disabled)` carries a dependency on `.disabled`; moving `.card` to a new sheet
  // would re-scope `.disabled` under a different css-module hash — a silent type-blind break.
  const v = classify('.card:not(.disabled) { color: red; }\n.disabled { opacity: 0.5; }', ['card']);
  assert.notEqual(code(v.get('card')), 'safe');
});

test('plain .module.css parses through postcss and classifies', () => {
  const v = classify('.card { color: red; }', ['card'], new Set(), 'x.module.css');
  assert.equal(code(v.get('card')), 'safe');
});
