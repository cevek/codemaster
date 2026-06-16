// `aliasMappedRel` resolves a tsconfig-`paths` aliased specifier to a repo-rel path, used by the
// css-module usage scanner and the move/extract specifier resolver. It must select the LONGEST
// matching KEY (as the TS compiler resolves `paths`) — NOT the `relPrefix`-length order
// `deriveAliasPrefixes` sorts for the EMIT direction. The regression this guards (bug-review):
// a nested alias whose more-specific key maps to a SHORTER target would otherwise resolve to the
// wrong sheet — a §3 lie. Oracle: hand-computed expectations matching tsc's longest-key rule.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { aliasMappedRel, type AliasPrefix } from '../../src/plugins/ts/alias-paths.ts';

const W = (aliasPrefix: string, relPrefix: string): AliasPrefix => ({
  wildcard: true,
  aliasPrefix,
  relPrefix,
});
const EXACT = (aliasPrefix: string, relPrefix: string): AliasPrefix => ({
  wildcard: false,
  aliasPrefix,
  relPrefix,
});

test('single wildcard alias maps to its target dir', () => {
  const prefixes = [W('@/', 'src/')];
  assert.equal(aliasMappedRel(prefixes, '@/feature/x.module.scss'), 'src/feature/x.module.scss');
});

test('LONGEST matching KEY wins, regardless of relPrefix-sort order', () => {
  // As `deriveAliasPrefixes` would sort them (longest relPrefix first): `@/` → deep dir BEFORE
  // `@/sub/` → shallow dir. The resolve direction must still pick the longer KEY `@/sub/`.
  const prefixes = [W('@/', 'src/components/longpath/'), W('@/sub/', 'lib/')];
  assert.equal(aliasMappedRel(prefixes, '@/sub/x.scss'), 'lib/x.scss');
  // A spec under only the broad alias still maps through it.
  assert.equal(aliasMappedRel(prefixes, '@/other/y.scss'), 'src/components/longpath/other/y.scss');
});

test('an EXACT (bare, non-wildcard) key matches only the full specifier', () => {
  const prefixes = [EXACT('@app', 'src/app/index'), W('@/', 'src/')];
  assert.equal(aliasMappedRel(prefixes, '@app'), 'src/app/index');
  assert.equal(aliasMappedRel(prefixes, '@apple'), null); // not a prefix match for a bare key
});

test('relative and bare-package specifiers map to null', () => {
  const prefixes = [W('@/', 'src/')];
  assert.equal(aliasMappedRel(prefixes, './x.scss'), null);
  assert.equal(aliasMappedRel(prefixes, '../y.scss'), null);
  assert.equal(aliasMappedRel(prefixes, 'react'), null);
});

test('a root-escaping alias specifier is declined (null), like the relative side', () => {
  const prefixes = [W('@/', 'src/')];
  assert.equal(aliasMappedRel(prefixes, '@/../../escape.scss'), null);
  // A `..` that stays within root normalizes cleanly.
  assert.equal(aliasMappedRel(prefixes, '@/a/../b.scss'), 'src/b.scss');
});
