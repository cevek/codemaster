// Oracle for the cascade specificity tokenizer + subject analysis (spec-css-cascade-op): a
// hand-rolled selector parser is the easiest place to hide a bug, so pin it against the
// canonical W3C Selectors-4 examples (the oracle is the spec's own hand-computed triples)
// and assert the subject/condition extraction the resolver's honesty rides on.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  analyzeBranch,
  formatSpecificity,
  specificityOfComplex,
} from '../../src/plugins/scss/cascade/specificity.ts';

const SPECIFICITY_ORACLE: ReadonlyArray<[string, string]> = [
  ['*', '0,0,0'],
  ['li', '0,0,1'],
  ['ul li', '0,0,2'],
  ['ul li .foo', '0,1,2'],
  ['.a.b', '0,2,0'],
  ['#id', '1,0,0'],
  ['#nav .list li', '1,1,1'],
  ['ul ol li.red', '0,1,3'],
  ['li:first-child', '0,1,1'],
  ['a:hover', '0,1,1'],
  ['.foo::before', '0,1,1'], // ::before is a pseudo-ELEMENT → c, .foo → b
  ['input[type="text"]', '0,1,1'], // element + attribute
  [':not(.a)', '0,1,0'], // :not takes the specificity of its argument
  [':not(.a.b)', '0,2,0'], // …the MAX of the arg list
  [':where(.a, #id)', '0,0,0'], // :where is always zero
  ['.a:not(.b)', '0,2,0'],
  ['.btn.btn--lg:hover', '0,3,0'],
  // :global()/:local() are compiled away — specificity-transparent (the ARGUMENT cascades),
  // never counted as a single class (which would collapse an id-level rule to class-level).
  [':global(#id)', '1,0,0'],
  [':global(.a.foo)', '0,2,0'],
  [':local(.a .b)', '0,2,0'],
  ['.x:global', '0,1,0'],
];

test('specificity matches the canonical W3C examples', () => {
  for (const [selector, expected] of SPECIFICITY_ORACLE) {
    assert.equal(
      formatSpecificity(specificityOfComplex(selector)),
      expected,
      `specificity of "${selector}"`,
    );
  }
});

test('subject = rightmost compound; only its classes target an element', () => {
  assert.deepEqual(analyzeBranch('.parent .foo').traits.subjectClasses, ['foo']);
  assert.deepEqual(analyzeBranch('.foo .bar').traits.subjectClasses, ['bar']);
  assert.deepEqual(analyzeBranch('.foo.bar').traits.subjectClasses, ['foo', 'bar']);
  assert.deepEqual(analyzeBranch('div.foo').traits.subjectClasses, ['foo']);
  // an ancestor/sibling-only class is NOT a subject class (the §"foo only an ancestor" trap).
  assert.ok(!analyzeBranch('.foo > .bar').traits.subjectClasses.includes('foo'));
});

test('conditions flag every non-unconditional shape', () => {
  assert.deepEqual(analyzeBranch('.foo').traits.conditions, []);
  assert.deepEqual(analyzeBranch('.parent .foo').traits.conditions, ['descendant']);
  assert.deepEqual(analyzeBranch('.a > .foo').traits.conditions, ['descendant']);
  assert.deepEqual(analyzeBranch('.foo:hover').traits.conditions, ['pseudo-class']);
  assert.deepEqual(analyzeBranch('.foo[data-x]').traits.conditions, ['attribute']);
  assert.deepEqual(analyzeBranch('.foo:not(.bar)').traits.conditions, ['negation']);
  assert.deepEqual(analyzeBranch('.foo::before').traits.conditions, ['pseudo-element']);
});

test('interpolation is flagged (specificity becomes a lower bound, never a fabricated certainty)', () => {
  assert.equal(analyzeBranch('.foo-#{$mod}').traits.interpolated, true);
  assert.equal(analyzeBranch('.foo').traits.interpolated, false);
});

test('interpolation `#{…}` never inflates specificity into a phantom id/type (the ordering key)', () => {
  // `#{` must NOT count the `#` as an id (a=1 would outrank every real .class) nor tokenize
  // the inner `$x` as a type — the bug that corrupted the cross-rule ordering.
  assert.equal(formatSpecificity(specificityOfComplex('.foo-#{$mod}')), '0,1,0');
  assert.equal(formatSpecificity(specificityOfComplex('#{$sel}')), '0,0,0');
  assert.equal(formatSpecificity(specificityOfComplex('.a#{$x}.b')), '0,2,0');
});

test('a type-/id-qualified subject is a CONDITION, never an unconditional match', () => {
  // `button.foo` matches only <button>, `#nav.foo` only the #nav element — both are real
  // restrictions, so the resolver must never call such a winner `certain`.
  assert.deepEqual(analyzeBranch('button.foo').traits.conditions, ['element-type']);
  assert.deepEqual(analyzeBranch('#nav.foo').traits.conditions, ['id']);
  assert.deepEqual(analyzeBranch('.foo').traits.conditions, []);
});

test('a `]` or space inside a quoted attribute value does not split the compound', () => {
  // quote-unaware parsing would cut the attr at the inner `]` / fabricate a descendant combinator.
  assert.equal(formatSpecificity(specificityOfComplex('.a[title="a]b"]')), '0,2,0');
  assert.deepEqual(analyzeBranch('.foo[data-x="a b"]').traits.conditions, ['attribute']);
  assert.deepEqual(analyzeBranch('.foo[data-x="a b"]').traits.subjectClasses, ['foo']);
});
