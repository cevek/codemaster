// Density (output-audit) fixes for the scss / css_cascade renderers — the FACT must survive
// byte-for-byte in json while the TEXT drops a duplicate. Oracle = a fresh (cold-built) project()
// with hand-built expectations, plus a json round-trip proving no field was lost (the dedup is
// render-only). Covers: css_cascade #1 (no verbatim `prop: value;` echo; subject selector shown
// only as the suffix that differs from the target), scss_classes #8 (bare name dropped when the
// span text already is `.name`), find_unused_scss_classes #4 (a per-row note that just restates the
// dynamicModules/globalModules section is dropped).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { project } from '../helpers/project.ts';
import { renderResult, renderResultJson } from '../../src/format/render/render-result.ts';
import { stripShapeTags } from '../../src/common/shape-tag/tag.ts';
import { leakedTag } from '../helpers/density.ts';

const TSCONFIG = '{"compilerOptions":{"strict":true}}';

test('leakedTag guard: a field-position ~meta key fires; a SymbolId ~rootTag / CSS `~` combinator do not (anti-vacuity)', () => {
  assert.ok(leakedTag('  ~subject=card') !== undefined, 'a leaked scalar meta field IS caught');
  assert.ok(
    leakedTag('  - ~sectioned=true') !== undefined,
    'a leaked bullet-first meta field IS caught',
  );
  assert.equal(
    leakedTag('  src/a.ts:2:14~18f5c50e (variable, exported)'),
    undefined,
    'a SymbolId ~rootTag mid-value is NOT a leak',
  );
  assert.equal(
    leakedTag('  color: 0,1,0 · .a ~ .b = red'),
    undefined,
    'a CSS `~` combinator is NOT a leak',
  );
});

/** A `~`-meta key (`~subject`/`~sectioned`/…) is render-only — it must reach NO verbosity's text,
 *  including `full` (where css/scss rows explode via the dispatcher passthrough, NOT the renderer,
 *  so the passthrough itself must strip the meta). */
function assertNoMetaLeak(result: Parameters<typeof renderResult>[0]): void {
  for (const v of ['terse', 'normal', 'full'] as const) {
    const leak = leakedTag(renderResult(result, v));
    assert.equal(leak, undefined, `no ~meta key may leak to text at ${v} (got: ${leak})`);
  }
}

test('css_cascade #1: no verbatim `prop: value;` echo; target subject not repeated, suffix only when it differs', async () => {
  const p = await project({
    'tsconfig.json': TSCONFIG,
    'src/x.module.scss':
      '.card { display: block; }\n.card:hover { cursor: pointer; }\n.card.active { outline: 1px solid; }\n',
  });
  try {
    const r = await p.op('css_cascade', { file: 'src/x.module.scss', class: 'card' });
    assert.ok('result' in r && r.result.ok, 'op ok');
    // css-* shapes are NOT in COLLAPSE_AT_FULL (full = verbatim explode), so the renderer — and the
    // dedup — runs at terse/normal; full is the proof-verbatim mode and not asserted here.
    for (const v of ['terse', 'normal'] as const) {
      const out = renderResult(r.result, v);
      // value printed ONCE: the winner `= block`, never the verbatim `display: block;` decl text.
      assert.doesNotMatch(out, /display: block;/, `${v}: no verbatim decl echo`);
      assert.doesNotMatch(out, /cursor: pointer;/, `${v}: no verbatim decl echo`);
      assert.match(out, /= block\b/, `${v}: winner value kept`);
      // subject `.card` IS the target → never repeated as `.card = …`; the differing suffix shows.
      assert.doesNotMatch(out, /\.card = /, `${v}: target subject not repeated`);
      assert.match(out, /· :hover = pointer\b/, `${v}: :hover suffix shown (differs from target)`);
      assert.match(out, /· \.active = /, `${v}: .active suffix shown (differs from target)`);
    }
    // FACT preserved in json: the winner still carries its full selector + value.
    const data = stripShapeTags(r.result.data) as {
      properties: { prop: string; winner: { selector: string; value: string } }[];
    };
    const display = data.properties.find((x) => x.prop === 'display');
    assert.equal(display?.winner.selector, '.card', 'json keeps the full selector');
    assert.equal(display?.winner.value, 'block', 'json keeps the value');
    const hover = data.properties.find((x) => x.prop === 'cursor');
    assert.equal(hover?.winner.selector, '.card:hover', 'json keeps the full :hover selector');
    assert.doesNotMatch(renderResultJson(r.result), /~/, 'no meta key leaks to json');
    assertNoMetaLeak(r.result); // ~subject must not leak at full (css-* explode via passthrough)
  } finally {
    await p.dispose();
  }
});

test('css_cascade #1/R2: a selector sharing only a name PREFIX (no token boundary) is not corrupted', async () => {
  const p = await project({
    'tsconfig.json': TSCONFIG,
    'src/x.module.scss':
      '.btn { display: block; }\n' +
      '.btn-group .btn { color: red; }\n' + // ancestor `.btn-group` shares the `.btn` prefix, `-`
      '.btn:hover { cursor: pointer; }\n' + // `:` IS a token boundary → suffix `:hover`
      '.block { font-weight: 600; }\n' +
      '.block__el .block { color: green; }\n', // ancestor `.block__el` shares `.block` prefix, `_`
  });
  try {
    const btn = await p.op('css_cascade', { file: 'src/x.module.scss', class: 'btn' });
    assert.ok('result' in btn && btn.result.ok, 'op ok');
    const outB = renderResult(btn.result, 'normal');
    // the `.btn-group .btn` winner keeps its FULL selector — never sliced to a corrupt `-group .btn`.
    assert.match(outB, /· \.btn-group \.btn = red/, 'prefix-sharing ancestor not corrupted');
    assert.doesNotMatch(outB, /· -group/, 'no leading `.btn` of `.btn-group` sliced off');
    assert.match(outB, /· :hover = pointer/, 'a real token boundary still trims to the suffix');
    assert.match(outB, /[^.]= block/, 'the exact-target winner still drops the subject');
    const block = await p.op('css_cascade', { file: 'src/x.module.scss', class: 'block' });
    assert.ok('result' in block && block.result.ok, 'op ok');
    assert.match(
      renderResult(block.result, 'normal'),
      /· \.block__el \.block = green/,
      'BEM prefix-sharing ancestor not corrupted',
    );
  } finally {
    await p.dispose();
  }
});

test('scss_classes #8: bare name dropped when the span text is `.name`; kept at terse (sole id)', async () => {
  const p = await project({
    'tsconfig.json': TSCONFIG,
    // `.card` → span token IS `.card` (echo). `&--mod` → synthesized name `block--mod` whose span
    // token is `&--mod` (≠ `.block--mod`) → the name must be KEPT (the don't-over-drop branch).
    'src/x.module.scss': '.card { color: red; }\n.block { &--mod { flex: 1; } }\n',
  });
  try {
    const r = await p.op('scss_classes', { file: 'src/x.module.scss' });
    assert.ok('result' in r && r.result.ok, 'op ok');
    // normal: the span text is `.card` → the bare `· card` echo is dropped (scss-class is not in
    // COLLAPSE_AT_FULL, so full explodes verbatim and is not asserted).
    const normal = renderResult(r.result, 'normal');
    assert.match(normal, /· \.card\b/, 'normal: selector shown');
    assert.doesNotMatch(normal, /\.card · card\b/, 'normal: bare name echo dropped');
    // the synthesized BEM name is NOT echoed by its span token → it must survive (no fact loss).
    assert.match(normal, /· block--mod\b/, 'normal: a non-echoed synthesized name is kept');
    // terse carries no span text, so the bare name is the ONLY identifier — it must stay.
    assert.match(renderResult(r.result, 'terse'), /· card\b/, 'terse keeps the name');
    // FACT preserved: the class names are still in data.
    const data = stripShapeTags(r.result.data) as { classes: { name: string }[] };
    assert.ok(
      data.classes.some((c) => c.name === 'card') &&
        data.classes.some((c) => c.name === 'block--mod'),
      'json keeps the names',
    );
    assertNoMetaLeak(r.result);
  } finally {
    await p.dispose();
  }
});

test('find_unused_scss_classes #4: a per-row note that restates the dynamicModules section is dropped (note stays in json)', async () => {
  const p = await project({
    'tsconfig.json': TSCONFIG,
    'src/m.module.scss': '.alpha { color: red; }\n.beta { color: blue; }\n',
    // a global (non-.module) sheet — its classes are reached via string classNames codemaster can't
    // resolve, so they demote with the SAME "global stylesheet" note and the sheet is named in the
    // globalModules section (the second half of #4, distinct note text from the dynamic one).
    'src/global.scss': '.gbtn { color: red; }\n',
    // computed access → m.module.scss's classes demote with the SAME "computed access" note,
    // and the module is named in the dynamicModules section.
    'src/use.ts': "import s from './m.module.scss';\nexport const pick = (k: string) => s[k];\n",
  });
  try {
    const r = await p.op('find_unused_scss_classes', {});
    assert.ok('result' in r && r.result.ok, 'op ok');
    const data0 = stripShapeTags(r.result.data) as {
      dynamicModules?: string[];
      globalModules?: string[];
      unused: { name: string; note?: string }[];
    };
    assert.ok(
      (data0.dynamicModules ?? []).some((m) => m.includes('m.module.scss')),
      'module flagged dynamic (precondition)',
    );
    assert.ok(
      (data0.globalModules ?? []).some((m) => m.includes('global.scss')),
      'sheet flagged global (precondition)',
    );
    for (const v of ['terse', 'normal'] as const) {
      const out = renderResult(r.result, v);
      // both repeated per-row notes are gone from text…
      assert.doesNotMatch(
        out,
        /importer uses computed access/,
        `${v}: dynamic per-row note dropped`,
      );
      assert.doesNotMatch(out, /global stylesheet/, `${v}: global per-row note dropped`);
      // …but the carrier sections still name each sheet.
      assert.match(out, /dynamicModules/, `${v}: dynamic section kept`);
      assert.match(out, /m\.module\.scss/, `${v}: dynamic module named`);
      assert.match(out, /globalModules/, `${v}: global section kept`);
      assert.match(out, /global\.scss/, `${v}: global sheet named`);
    }
    // FACT preserved: each per-row note is still in json.
    assert.match(
      data0.unused.find((u) => u.name === 'alpha')?.note ?? '',
      /computed access/,
      'json keeps the dynamic per-row note',
    );
    assert.match(
      data0.unused.find((u) => u.name === 'gbtn')?.note ?? '',
      /global stylesheet/,
      'json keeps the global per-row note',
    );
    assertNoMetaLeak(r.result); // ~sectioned must not leak at full
  } finally {
    await p.dispose();
  }
});
