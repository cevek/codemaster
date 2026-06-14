// Stage 2 oracle (spec-css-coextract §2.4): the rule transform is verified by an INDEPENDENT
// cold reparse of both outputs — moved rules present in the new sheet & absent from the
// source, untouched rules byte-stable, leading comments carried. Covers .scss and .module.css.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseStylesheetRoot } from '../../src/plugins/scss/parse-root.ts';
import { extractRules } from '../../src/plugins/scss/extract-rules.ts';

/** Oracle: the set of top-level rule selectors present in a sheet, via a cold reparse. */
function selectors(source: string, file: string): string[] {
  const parsed = parseStylesheetRoot(source, file);
  assert.ok(parsed.ok, `output must reparse: ${parsed.ok ? '' : parsed.message}`);
  const out: string[] = [];
  parsed.root.walkRules((r) => {
    out.push(r.selector);
  });
  return out;
}

function run(
  source: string,
  safe: string[],
  file = 'x.module.scss',
): ReturnType<typeof extractRules> {
  const parsed = parseStylesheetRoot(source, file);
  assert.ok(parsed.ok);
  return extractRules(parsed.root, safe, file);
}

test('moves owned rules to the new sheet and removes them from the source', () => {
  const src = '.card { color: red; }\n.title { font-weight: bold; }\n.shared { margin: 0; }\n';
  const { newSheet, sourceSheet } = run(src, ['card', 'title']);
  assert.deepEqual(selectors(newSheet, 'n.module.scss').sort(), ['.card', '.title']);
  assert.deepEqual(selectors(sourceSheet, 'x.module.scss'), ['.shared']);
});

test('untouched rules are byte-stable in the source', () => {
  const src = '.card {\n  color: red;\n}\n\n.shared {\n  margin: 0 auto;\n  padding: 4px;\n}\n';
  const { sourceSheet } = run(src, ['card']);
  // The remaining rule's declarations survive verbatim (independent substring oracle).
  assert.match(sourceSheet, /\.shared\s*\{[^}]*margin: 0 auto;[^}]*padding: 4px;[^}]*\}/);
  assert.doesNotMatch(sourceSheet, /\.card/);
});

test('a leading comment block travels with its rule', () => {
  const src = '/* the card */\n.card { color: red; }\n.shared { margin: 0; }\n';
  const { newSheet, sourceSheet } = run(src, ['card']);
  assert.match(newSheet, /the card/);
  assert.match(newSheet, /\.card/);
  assert.doesNotMatch(sourceSheet, /the card/);
  assert.doesNotMatch(sourceSheet, /\.card/);
});

test('a file header separated by a blank line is NOT stolen by the first rule', () => {
  // The `/* Copyright */` header is detached (blank line) → it must stay in the source sheet,
  // not get carried into the new sheet (would delete a license from the source).
  const src = '/* Copyright 2026 */\n\n.card { color: red; }\n.shared { margin: 0; }\n';
  const { newSheet, sourceSheet } = run(src, ['card']);
  assert.match(newSheet, /\.card/);
  assert.doesNotMatch(newSheet, /Copyright/); // header NOT carried away
  assert.match(sourceSheet, /Copyright 2026/); // header stays in source
});

test('moving nothing leaves the source whole and the new sheet empty', () => {
  const src = '.a { color: red; }\n.b { color: blue; }\n';
  const { newSheet, sourceSheet } = run(src, []);
  assert.equal(selectors(newSheet, 'n.module.scss').length, 0);
  assert.deepEqual(selectors(sourceSheet, 'x.module.scss').sort(), ['.a', '.b']);
});

test('plain .module.css round-trips through postcss', () => {
  const src = '.card { color: red; }\n.shared { margin: 0; }\n';
  const { newSheet, sourceSheet } = run(src, ['card'], 'x.module.css');
  assert.deepEqual(selectors(newSheet, 'n.module.css'), ['.card']);
  assert.deepEqual(selectors(sourceSheet, 'x.module.css'), ['.shared']);
});
