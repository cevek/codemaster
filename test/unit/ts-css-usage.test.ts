// Stage 3 oracle (spec-css-coextract §2.3): block-scoped css-module usage + the conservative
// remaining-source wildcard + scope-aware shadow skipping, and the scope-aware extracted-file
// rewrite. Oracle = hand-written expected sets / output substrings next to each fixture.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  analyzeCssExtractUsage,
  rewriteExtractedCss,
} from '../../src/plugins/ts/refactor/extract/css-usage.ts';

function analyze(extracted: string, remaining: string): ReturnType<typeof analyzeCssExtractUsage> {
  return analyzeCssExtractUsage(
    { fileName: 'Card.tsx', content: extracted },
    { fileName: 'Panel.tsx', content: remaining },
  );
}

test('splits extracted vs remaining refs; the remaining one is left behind', () => {
  const extracted =
    "import s from './Panel.module.scss';\nexport const Card = () => <div className={s.a}><span className={s.b} /></div>;\n";
  const remaining =
    "import s from './Panel.module.scss';\nexport const Panel = () => <section className={s.b} />;\n";
  const [u] = analyze(extracted, remaining);
  assert.ok(u !== undefined);
  assert.deepEqual(u.refsInExtracted.sort(), ['a', 'b']);
  assert.deepEqual(u.refsInRemaining, ['b']);
  assert.equal(u.remainingWildcard, false);
  assert.equal(u.localName, 's');
  assert.equal(u.specifier, './Panel.module.scss');
});

test('a spread {...s} in the remaining source flags a wildcard (leave all)', () => {
  const extracted =
    "import s from './x.module.scss';\nexport const Card = () => <div className={s.a} />;\n";
  const remaining = "import s from './x.module.scss';\nexport const rest = { ...s };\n";
  const [u] = analyze(extracted, remaining);
  assert.ok(u !== undefined);
  assert.equal(u.remainingWildcard, true);
});

test('a computed s[expr] in the remaining source flags a wildcard', () => {
  const extracted =
    "import s from './x.module.scss';\nexport const Card = () => <div className={s.a} />;\n";
  const remaining = "import s from './x.module.scss';\nexport const pick = (k: string) => s[k];\n";
  const [u] = analyze(extracted, remaining);
  assert.ok(u !== undefined);
  assert.equal(u.remainingWildcard, true);
});

test('a lambda parameter shadowing the import name is NOT counted', () => {
  const extracted =
    "import s from './x.module.scss';\nexport const Card = () => <div className={s.a} />;\n";
  // `s` here is the map callback param, not the css import — must not register as a ref/wildcard.
  const remaining =
    "import s from './x.module.scss';\nexport const rows = [1].map((s) => s.toFixed(2));\n";
  const [u] = analyze(extracted, remaining);
  assert.ok(u !== undefined);
  assert.deepEqual(u.refsInRemaining, []);
  assert.equal(u.remainingWildcard, false);
});

test('no css import in the extracted file → no usage', () => {
  assert.deepEqual(analyze('export const Card = () => <div />;\n', 'export const x = 1;\n'), []);
});

test('a non-trivial use of the import IN THE EXTRACTED block flags extractedWildcard', () => {
  const extracted =
    "import s from './x.module.scss';\nexport const Card = () => { const cx = s; return <div className={cx.a} />; };\n";
  const [u] = analyze(extracted, 'export const Panel = () => null;\n');
  assert.ok(u !== undefined);
  assert.equal(u.extractedWildcard, true);
});

test('a literal-only extracted block does not flag extractedWildcard', () => {
  const extracted =
    "import s from './x.module.scss';\nexport const Card = () => <div className={s.a} />;\n";
  const [u] = analyze(extracted, 'export const Panel = () => null;\n');
  assert.ok(u !== undefined);
  assert.equal(u.extractedWildcard, false);
});

test('a member name / object key matching the import name is NOT a false wildcard', () => {
  const extracted =
    "import s from './x.module.scss';\nexport const Card = () => <div className={s.a} />;\n";
  // `props.s` (member name) and `{ s: 1 }` (object key) are not value uses of the import.
  const remaining =
    "import s from './x.module.scss';\nexport const Panel = (props: { s: number }) => { const o = { s: 1 }; return props.s + o.s; };\n";
  const [u] = analyze(extracted, remaining);
  assert.ok(u !== undefined);
  assert.equal(u.remainingWildcard, false);
});

test('an object-literal shorthand { s } IS a real value use → wildcard', () => {
  const extracted =
    "import s from './x.module.scss';\nexport const Card = () => <div className={s.a} />;\n";
  const remaining = "import s from './x.module.scss';\nexport const rest = () => ({ s });\n";
  const [u] = analyze(extracted, remaining);
  assert.ok(u !== undefined);
  assert.equal(u.remainingWildcard, true);
});

test('rewrite: repoint import, inject Legacy, repoint only left-behind refs', () => {
  const extracted =
    "import s from './Panel.module.scss';\n" +
    'export const Card = () => <div className={s.card}><b className={s.legacy} /></div>;\n';
  const out = rewriteExtractedCss('Card.tsx', extracted, [
    {
      localName: 's',
      newSpec: './Card.module.scss',
      legacySpec: '../feature/Panel.module.scss',
      leftBehind: ['legacy'],
    },
  ]);
  assert.match(out, /import s from ["']\.\/Card\.module\.scss["']/);
  assert.match(out, /import sLegacy from ["']\.\.\/feature\/Panel\.module\.scss["']/);
  assert.match(out, /className=\{sLegacy\.legacy\}/); // left-behind ref repointed
  assert.match(out, /className=\{s\.card\}/); // moved ref untouched
});

test('rewrite with nothing left behind only repoints the import', () => {
  const extracted =
    "import s from './Panel.module.scss';\nexport const Card = () => <div className={s.card} />;\n";
  const out = rewriteExtractedCss('Card.tsx', extracted, [
    {
      localName: 's',
      newSpec: './Card.module.scss',
      legacySpec: './Panel.module.scss',
      leftBehind: [],
    },
  ]);
  assert.match(out, /import s from ["']\.\/Card\.module\.scss["']/);
  assert.doesNotMatch(out, /Legacy/);
  assert.match(out, /className=\{s\.card\}/);
});

test('rewrite is scope-aware: a shadowed s.X is not repointed', () => {
  const extracted =
    "import s from './Panel.module.scss';\n" +
    'export const Card = () => {\n  const f = (s: { card: string }) => s.card;\n  return <div className={s.legacy}>{f({ card: "x" })}</div>;\n};\n';
  const out = rewriteExtractedCss('Card.tsx', extracted, [
    {
      localName: 's',
      newSpec: './Card.module.scss',
      legacySpec: './Panel.module.scss',
      leftBehind: ['card', 'legacy'],
    },
  ]);
  // The lambda's `s.card` is the parameter, NOT the css import — must stay `s.card`.
  assert.match(out, /\(s: \{ card: string \}\) => s\.card/);
  // The real css-import ref IS repointed.
  assert.match(out, /className=\{sLegacy\.legacy\}/);
});
