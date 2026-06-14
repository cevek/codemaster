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
