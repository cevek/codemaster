// The deny-by-default truncation guard (t-188210): the ESLint `no-restricted-syntax` rule that bans
// the ad-hoc string-elide ternary outside `common/truncate/`. Oracle-backed: the guard SELECTOR is
// read FROM the shipped `eslint.config.js` (no drift — the test exercises the real selector, not a
// copy), and the discriminator is a red→green pair — the banned idiom must FIRE, the chokepoint call
// and a legit length-ternary must be SILENT. This is the "guard actually catches a new ad-hoc
// truncation" proof (deny-by-default).

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Linter } from 'eslint';
import tseslint from 'typescript-eslint';

// Extract the real selector from eslint.config.js. It is a single-quoted string that begins with
// `ConditionalExpression` and contains only double quotes internally, so it never closes early.
const CONFIG = readFileSync(new URL('../../eslint.config.js', import.meta.url), 'utf8');
const match = /'(ConditionalExpression[^']+)'/.exec(CONFIG);
if (match === null) throw new Error('truncation guard selector not found in eslint.config.js');
const SELECTOR = match[1];

const linter = new Linter();
function truncationHits(code: string): number {
  const messages = linter.verify(code, {
    languageOptions: { parser: tseslint.parser as Linter.Parser },
    rules: { 'no-restricted-syntax': ['error', { selector: SELECTOR }] },
  });
  return messages.filter((m) => m.ruleId === 'no-restricted-syntax').length;
}

test('guard FIRES on the banned ad-hoc string-elide ternary', () => {
  const banned =
    'const f = (s: string, cap: number) => (s.length > cap ? `${s.slice(0, cap)}…` : s);';
  assert.equal(truncationHits(banned), 1, 'the exact recurring idiom must be caught');
});

test('guard is SILENT on the chokepoint call (routed through elideString)', () => {
  const clean = 'const f = (s: string, cap: number) => elideString(s, cap).text;';
  assert.equal(truncationHits(clean), 0, 'routing through the chokepoint is the allowed form');
});

test('guard is SILENT on a legit length-ternary whose consequent is NOT a truncation template', () => {
  // The cross-program fanout shape `a.length > 0 ? a : p.slice(0,1)` — a `.length` comparison AND a
  // `.slice`, but the consequent is an Identifier, not a `…`-template. Must not fire (no false positive).
  const legit = 'const f = (a: number[], p: number[]) => (a.length > 0 ? a : p.slice(0, 1));';
  assert.equal(truncationHits(legit), 0, 'no false positive on a non-truncation length-ternary');
});
