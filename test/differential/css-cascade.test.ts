// `css_cascade` op honesty (spec-css-cascade-op, DoD §16): a class targeted by a local
// rule AND a higher-specificity CROSS-MODULE descendant/attribute rule — the op must report
// BOTH, order them by specificity, and NAME the cross-module winner per property; a state
// selector is `partial`, never a false resolved winner. Oracle = the fixture's own
// hand-computed specificity/scope structure, plus proof-span validity (§16 inv.1).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { project, assertSpansValid } from '../helpers/project.ts';
import type { OpResult } from '../../src/ops/contracts.ts';

type Ref = {
  value: string;
  file: string;
  selector: string;
  specificity: string;
  important: boolean;
};
type Winner = Ref & { confidence: string; note?: string; ambiguousWith?: Ref[] };
type Property = { prop: string; winner: Winner; losers: Ref[] };
type Rule = { file: string; selector: string; specificity: string; crossModule: boolean };
type Data = {
  target: string;
  file?: string;
  confidence: string;
  notes?: string[];
  properties: Property[];
  rules: Rule[];
};

// Two CSS modules. `.card` lives in card.module.scss (the owning module). layout.module.scss
// has a HIGHER-specificity cross-module descendant rule on a same-named `.card`, plus an
// attribute rule — the silent cross-module override trap the op exists to surface.
const FILES = {
  'tsconfig.json': '{"compilerOptions":{"strict":true}}',
  'src/card.module.scss':
    '.card {\n  color: red;\n  padding: 4px;\n}\n' + // [0,1,0] same-module, unconditional
    '.card:hover {\n  outline: 1px solid;\n}\n' + // [0,2,0] same-module STATE → partial
    '.card .inner {\n  margin: 0;\n}\n', // subject is .inner, NOT .card — must be excluded
  'src/layout.module.scss':
    '.wrap .card {\n  color: blue;\n}\n' + // [0,2,0] CROSS-MODULE descendant → beats local red
    '.card[data-active] {\n  background: green;\n}\n', // [0,2,0] cross-module attribute
};

async function cascade(p: Awaited<ReturnType<typeof project>>, args: object): Promise<Data> {
  const r: OpResult = await p.op('css_cascade', args as never);
  assert.ok('result' in r && r.result.ok, 'op succeeded');
  return r.result.data as Data;
}

function prop(data: Data, name: string): Property {
  const found = data.properties.find((x) => x.prop === name);
  assert.ok(found !== undefined, `property ${name} present`);
  return found;
}

test('cross-module higher-specificity rule is NAMED as the winner, ordered, and marked partial', async () => {
  const p = await project(FILES);
  try {
    const r: OpResult = await p.op('css_cascade', {
      file: 'src/card.module.scss',
      class: 'card',
    });
    assert.ok('result' in r && r.result.ok);
    const data = r.result.data as Data;

    // color: the cross-module `.wrap .card` [0,2,0] beats the local `.card` [0,1,0] red.
    const color = prop(data, 'color');
    assert.equal(color.winner.value, 'blue', 'cross-module winner is NAMED, not dropped');
    assert.equal(color.winner.file, 'src/layout.module.scss');
    assert.equal(color.winner.specificity, '0,2,0');
    assert.equal(color.winner.confidence, 'partial', 'cross-module is never a proven winner');
    assert.match(color.winner.note ?? '', /cross-module|contextual/);
    // the local red is reported as a loser (both are surfaced).
    assert.ok(color.losers.some((l) => l.value === 'red' && l.file === 'src/card.module.scss'));

    // padding: only the local unconditional `.card` declares it → certain.
    const padding = prop(data, 'padding');
    assert.equal(padding.winner.value, '4px');
    assert.equal(
      padding.winner.confidence,
      'certain',
      'same-module unconditional static = certain',
    );

    // outline: same-module but STATE (:hover) → partial, never a false certain winner.
    const outline = prop(data, 'outline');
    assert.equal(outline.winner.confidence, 'partial');
    assert.match(outline.winner.note ?? '', /pseudo-class|state/);

    // background: cross-module attribute rule → partial.
    const background = prop(data, 'background');
    assert.equal(background.winner.confidence, 'partial');
    assert.equal(background.winner.file, 'src/layout.module.scss');

    // `.card .inner` has subject `.inner`, so `margin` is NOT a property of `.card`.
    assert.ok(
      !data.properties.some((x) => x.prop === 'margin'),
      'ancestor-context class is excluded',
    );

    // rules ordered by specificity desc — the [0,2,0] contributors come before [0,1,0].
    const specs = data.rules.map((x) => x.specificity);
    const firstLow = specs.indexOf('0,1,0');
    assert.ok(
      specs.slice(0, firstLow).every((s) => s === '0,2,0'),
      'specificity-descending order',
    );

    assert.equal(data.confidence, 'partial', 'overall confidence is worst-of the winners');
    // proof spans must equal the live source (the §16 inv.1 sweep, here pinned explicitly).
    assert.ok(assertSpansValid(p.root, r) >= 4, 'every emitted span is a real source slice');
  } finally {
    await p.dispose();
  }
});

test('a class with no targeting rule is an honest empty answer, not a fabricated winner', async () => {
  const p = await project(FILES);
  try {
    const data = await cascade(p, { file: 'src/card.module.scss', class: 'doesNotExist' });
    assert.equal(data.properties.length, 0);
    assert.ok(
      (data.notes ?? []).some((n) => /no rule/.test(n)),
      'says it found nothing',
    );
    // A no-match answer is `partial`, not `certain`: the syntactic scan over only the indexed
    // sheets cannot prove a class is targeted by NOTHING (§3.4 completeness honesty).
    assert.equal(data.confidence, 'partial', 'empty is an honest partial, not a proven absence');
  } finally {
    await p.dispose();
  }
});

test('pathInclude scopes the cross-sheet search; the owning sheet is always searched', async () => {
  const p = await project(FILES);
  try {
    // Exclude layout.module.scss from the search → the cross-module override disappears,
    // and the local `.card` color is now the proven (certain) winner.
    const data = await cascade(p, {
      file: 'src/card.module.scss',
      class: 'card',
      pathInclude: ['src/card.module.scss'],
    });
    const color = prop(data, 'color');
    assert.equal(color.winner.value, 'red');
    assert.equal(
      color.winner.confidence,
      'certain',
      'no cross-module rule in scope → local wins certainly',
    );
    assert.ok(!data.rules.some((x) => x.file === 'src/layout.module.scss'), 'layout excluded');
  } finally {
    await p.dispose();
  }
});

test('selector mode resolves the subject class and reports its cascade', async () => {
  const p = await project(FILES);
  try {
    // `.wrap .card` subject is `.card`; across >1 sheet, every contributor is cross-module.
    const data = await cascade(p, { selector: '.wrap .card' });
    assert.equal(data.target, 'card');
    assert.ok(data.properties.length > 0, 'resolves the subject class cascade');
  } finally {
    await p.dispose();
  }
});

test('a same-module type-qualified subject (`button.box`) is partial, never a false certain winner', async () => {
  const p = await project({
    'tsconfig.json': '{"compilerOptions":{"strict":true}}',
    // Both in ONE module: `button.box` [0,1,1] outranks `.box` [0,1,0] by specificity, but it
    // only matches a <button>; on any other element `.box` wins. So the winner is NOT certain.
    'src/a.module.scss': '.box { color: blue; }\nbutton.box { color: red; }\n',
  });
  try {
    const data = await cascade(p, { file: 'src/a.module.scss', class: 'box' });
    const color = prop(data, 'color');
    assert.equal(color.winner.value, 'red', 'higher specificity is still NAMED as the winner');
    assert.equal(color.winner.confidence, 'partial', 'element-qualified → not a proven winner');
    assert.match(color.winner.note ?? '', /element/);
  } finally {
    await p.dispose();
  }
});

test('a higher-specificity :global() rule is not mis-ranked below a local rule (never a certain wrong winner)', async () => {
  const p = await project({
    'tsconfig.json': '{"compilerOptions":{"strict":true}}',
    // `:global(.a.foo)` is (0,2,0) and must outrank the local `.foo` (0,1,0). Counting the
    // `:global()` wrapper as a single class would collapse it to (0,1,0), tie, and source-order
    // would promote the local `.foo` (blue) to a CERTAIN winner — a proven-wrong answer.
    'src/a.module.scss': ':global(.a.foo) {\n  color: red;\n}\n.foo {\n  color: blue;\n}\n',
  });
  try {
    const data = await cascade(p, { file: 'src/a.module.scss', class: 'foo' });
    const color = prop(data, 'color');
    assert.equal(
      color.winner.value,
      'red',
      ':global(.a.foo) outranks the local .foo by specificity',
    );
    assert.equal(color.winner.specificity, '0,2,0');
    assert.equal(
      color.winner.confidence,
      'partial',
      ':global is not module-scoped → never certain',
    );
  } finally {
    await p.dispose();
  }
});

test('a sibling sheet that FAILS to parse demotes every winner to partial — an unscanned sheet is unprovable scope', async () => {
  // The owning sheet's `.card` is the ONLY rule that targets the class and is same-module +
  // unconditional + static, so without any failure both winners would be `certain`. But an
  // in-scope sibling sheet whose cascade can't be parsed is UNSCANNED scope: a higher-specificity
  // cross-module rule could hide there. Reporting `certain` would then be a completeness lie
  // (§3.4/§3.6) — the op must cap to `partial` and NAME the unscanned sheet (bug-review, Task L).
  const p = await project({
    'tsconfig.json': '{"compilerOptions":{"strict":true}}',
    'src/card.module.scss': '.card {\n  color: red;\n  padding: 4px;\n}\n',
    'src/broken.module.scss': '.card {\n  color: green;\n', // unclosed block → parse failure
  });
  try {
    const r: OpResult = await p.op('css_cascade', { file: 'src/card.module.scss', class: 'card' });
    assert.ok('result' in r && r.result.ok);
    const data = r.result.data as Data & { parseFailures?: { file: string }[] };

    // The unscanned sheet is surfaced as a parse failure…
    assert.ok(
      (data.parseFailures ?? []).some((f) => f.file === 'src/broken.module.scss'),
      'the unparseable sheet is reported, not silently dropped',
    );
    // …and BOTH the per-property winners and the overall verdict are demoted from certain.
    assert.equal(prop(data, 'color').winner.confidence, 'partial', 'winner capped by failed scope');
    assert.equal(
      prop(data, 'padding').winner.confidence,
      'partial',
      'an otherwise-certain local winner is demoted while scope is incomplete',
    );
    assert.equal(
      data.confidence,
      'partial',
      'overall verdict is partial while a sheet is unscanned',
    );
    // A note must NAME the unscanned sheet so the agent knows where the gap is.
    assert.ok(
      (data.notes ?? []).some((n) => /broken\.module\.scss/.test(n) && /fail|parse|scan/.test(n)),
      'a note names the unscanned sheet and why confidence is capped',
    );
  } finally {
    await p.dispose();
  }
});

test('an !important declaration wins over a higher-specificity normal one', async () => {
  const p = await project({
    'tsconfig.json': '{"compilerOptions":{"strict":true}}',
    'src/a.module.scss': '.box { color: red !important; }\n',
    'src/b.module.scss': '.wrap .box { color: blue; }\n', // higher specificity, but NOT important
  });
  try {
    const data = await cascade(p, { file: 'src/a.module.scss', class: 'box' });
    const color = prop(data, 'color');
    assert.equal(color.winner.value, 'red', '!important beats specificity');
    assert.equal(color.winner.important, true);
  } finally {
    await p.dispose();
  }
});
