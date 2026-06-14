// Stage 2 oracle (spec-scss-css-honesty §2): the scss class extractor must synthesize the
// flat BEM names a parent-ref concat compiles to (`.block { &__el {} }` → `block__el`) with a
// span over the REAL `&__el` source token, and must exclude `:global(...)` break-out classes
// from the module-local set. Oracle = hand-built expectations + a span-text check against the
// source string (the same invariant assertSpansValid enforces end-to-end).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseScssClasses, type ScssClass } from '../../src/plugins/scss/parse.ts';
import type { RepoRelPath } from '../../src/core/brands.ts';

function parse(source: string): ScssClass[] {
  const out = parseScssClasses('x.module.scss' as RepoRelPath, source);
  assert.ok(out.ok, 'parse must succeed');
  return out.classes;
}

// Independent span oracle: the source substring at [line,col]→[endLine,endCol] (1-based,
// end-exclusive) must equal span.text — a drifted span is a lie (§16 inv.1).
function spanText(source: string, c: ScssClass): string {
  const lines = source.split('\n');
  const { line, col, endCol } = c.span;
  assert.equal(c.span.endLine, line, 'single-line spans only in this fixture');
  return (lines[line - 1] ?? '').slice(col - 1, endCol - 1);
}

test('BEM parent-ref concat synthesizes block__el / block--mod with honest spans', () => {
  const src = '.block {\n  &__el { display: flex; }\n  &--mod { flex: 1; }\n}\n';
  const classes = parse(src);
  const byName = new Map(classes.map((c) => [c.name, c]));
  assert.ok(byName.has('block'), 'the parent selector itself is still extracted');
  assert.ok(byName.has('block__el'), '&__el resolves to the flat class block__el');
  assert.ok(byName.has('block--mod'), '&--mod resolves to block--mod');
  // The synthesized span covers the REAL `&__el` token, not a fabricated `.block__el`.
  assert.equal(byName.get('block__el')?.span.text, '&__el');
  assert.equal(spanText(src, byName.get('block__el') as ScssClass), '&__el');
  assert.equal(byName.get('block--mod')?.span.text, '&--mod');
  assert.equal(spanText(src, byName.get('block--mod') as ScssClass), '&--mod');
});

test(':global(...) break-out classes are excluded from the module-local set', () => {
  const src = '.local { color: red; }\n:global(.escapeHatch) { color: blue; }\n';
  const names = new Set(parse(src).map((c) => c.name));
  assert.ok(names.has('local'), 'a real module-local class is kept');
  assert.ok(!names.has('escapeHatch'), ':global class is not a module-local class');
});

test(':global { ... } BLOCK form excludes every class nested inside it', () => {
  const src =
    '.local { color: red; }\n' +
    ':global {\n  .leaked { color: blue; }\n  .block { &__x { flex: 1; } }\n}\n';
  const names = new Set(parse(src).map((c) => c.name));
  assert.ok(names.has('local'), 'a real module-local class is kept');
  assert.ok(!names.has('leaked'), ':global block class is not module-local');
  assert.ok(!names.has('block'), ':global block parent is not module-local');
  assert.ok(!names.has('block__x'), 'a synthesized BEM name under :global is excluded too');
});

test('a parent-ref compound `&.active` still yields the literal class (unchanged)', () => {
  const names = new Set(parse('.card {\n  &.active { outline: 1px; }\n}\n').map((c) => c.name));
  assert.ok(names.has('card') && names.has('active'), 'card + active both present');
});

test('parent-ref concat glues to the LAST class of the parent trailing compound — never fabricated', () => {
  // `.a.b { &__el }` compiles to `.a.b__el` → the synthesized class is `b__el`, NOT `a__el`
  // (the first token); recording `a__el` is a class that does not exist in the CSS (§3.2 lie).
  const compound = new Set(parse('.a.b {\n  &__el { flex: 1; }\n}\n').map((c) => c.name));
  assert.ok(compound.has('b__el'), 'glues to the last class of the compound');
  assert.ok(!compound.has('a__el'), 'NOT the first class — that name is not in the CSS');

  // Descendant: `.outer .blk { &__el }` → `.outer .blk__el` → `blk__el`, not `outer__el`.
  const desc = new Set(parse('.outer .blk {\n  &__el { flex: 1; }\n}\n').map((c) => c.name));
  assert.ok(desc.has('blk__el') && !desc.has('outer__el'), 'glues to the trailing compound');

  // Comma list: `.a, .b { &__el }` compiles to BOTH `.a__el` and `.b__el` — emit each branch.
  const comma = new Set(parse('.a, .b {\n  &__el { flex: 1; }\n}\n').map((c) => c.name));
  assert.ok(comma.has('a__el') && comma.has('b__el'), 'both comma branches synthesized');

  // Deep chain: `.a.b { &__c { &--d } }` → `b__c--d` (the last-class fix propagates down).
  const deep = new Set(
    parse('.a.b {\n  &__c {\n    &--d { flex: 1; }\n  }\n}\n').map((c) => c.name),
  );
  assert.ok(deep.has('b__c--d') && !deep.has('a__c--d'), 'chain resolves through the last class');

  // Pseudo tail: `.blk:hover { &__el }` has no clean class to glue onto → synthesize NOTHING
  // (never a fabricated `blk__el` / `hover__el`); the literal `blk` is still extracted.
  const pseudo = new Set(parse('.blk:hover {\n  &__el { flex: 1; }\n}\n').map((c) => c.name));
  assert.ok(
    !pseudo.has('blk__el') && !pseudo.has('hover__el'),
    'no fabricated name on a pseudo tail',
  );
  assert.ok(pseudo.has('blk'), 'the parent class itself is still present');
});
