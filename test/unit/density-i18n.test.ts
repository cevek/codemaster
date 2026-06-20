// Density (output-audit) fixes for the i18n renderers — the FACT survives in json while the TEXT
// drops a duplicate. Oracle = a fresh (cold-built) project() with hand-built expectations + a json
// round-trip proving nothing was lost. i18n shapes ARE in COLLAPSE_AT_FULL, so the renderer (and the
// dedup) runs at terse/normal/full alike. Covers: i18n_lookup #7 (def span-token echo of the key's
// last segment dropped) + the same-family usage echo (span IS the full key → the separate key
// dropped); find_missing #2 (key echo dropped; a uniform missing-locale set hoisted to a header);
// find_unused #3 (span-token echo dropped; per-row `· partial` dropped under a global demote).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { project } from '../helpers/project.ts';
import { renderResult, renderResultJson } from '../../src/format/render/render-result.ts';
import { stripShapeTags } from '../../src/common/shape-tag/tag.ts';
import { leakedTag } from '../helpers/density.ts';

const TSCONFIG = '{"compilerOptions":{"strict":true}}';

/** A `~`-meta key (`~hideMissing`/`~hideConf`) is render-only — it must reach NO verbosity's text. */
function assertNoMetaLeak(result: Parameters<typeof renderResult>[0]): void {
  for (const v of ['terse', 'normal', 'full'] as const) {
    const leak = leakedTag(renderResult(result, v));
    assert.equal(leak, undefined, `no ~meta key may leak to text at ${v} (got: ${leak})`);
  }
}
const CONFIG =
  "import {defineConfig} from 'codemaster';\n" +
  "export default defineConfig({ i18n: { locales: ['locales/en.json'] } });\n";
const VERBOSITIES = ['terse', 'normal', 'full'] as const;

test('i18n_lookup #7: def drops the span key-token echo; usage drops the key when the span IS it', async () => {
  const p = await project({
    'tsconfig.json': TSCONFIG,
    'codemaster.config.ts': CONFIG,
    'locales/en.json': JSON.stringify({ widget: { actions: { save: 'Save' } } }),
    'src/use.ts': "const t=(k:string)=>k;\nexport const a=t('widget.actions.save');\n",
  });
  try {
    const r = await p.op('i18n_lookup', { key: 'widget.actions.save' });
    assert.ok('result' in r && r.result.ok, 'op ok');
    for (const v of VERBOSITIES) {
      const out = renderResult(r.result, v);
      // def: the full dotted key shows; the span's `"save"` token (last segment) is not echoed.
      assert.match(out, /· widget\.actions\.save · en=Save/, `${v}: def full key + value`);
      assert.doesNotMatch(out, /"save" · widget/, `${v}: def token echo dropped`);
      // usage: the span IS the full key (`'widget.actions.save'`) → the separate key is dropped.
      assert.doesNotMatch(out, /save' · widget\.actions\.save/, `${v}: usage key echo dropped`);
    }
    // FACT preserved: defs + usages still carry the key in json.
    const data = stripShapeTags(r.result.data) as {
      defs: { key: string; value: string }[];
      usages: { key: string }[];
    };
    assert.equal(data.defs[0]?.key, 'widget.actions.save', 'json keeps def key');
    assert.equal(data.usages[0]?.key, 'widget.actions.save', 'json keeps usage key');
    assert.doesNotMatch(renderResultJson(r.result), /~/, 'no meta key leaks to json');
    assertNoMetaLeak(r.result);
  } finally {
    await p.dispose();
  }
});

test('find_missing #2: key echo dropped; a uniform missing-locale set hoisted to a header note', async () => {
  const p = await project({
    'tsconfig.json': TSCONFIG,
    'codemaster.config.ts': CONFIG,
    'locales/en.json': JSON.stringify({ ok: 'OK' }),
    'src/use.ts':
      "const t=(k:string)=>k;\nexport const a=t('absent.one');\nexport const b=t('absent.two');\n",
  });
  try {
    const r = await p.op('find_missing_i18n_keys', {});
    assert.ok('result' in r && r.result.ok, 'op ok');
    for (const v of VERBOSITIES) {
      const out = renderResult(r.result, v);
      // every usage misses the SAME [en] → one header note, never `· missing in [en]` per row.
      assert.match(out, /missing in \[en\] on all 2 usage\(s\)/, `${v}: header note`);
      assert.equal(
        (out.match(/missing in \[/g) ?? []).length,
        1,
        `${v}: the locale list appears once (header), not per row`,
      );
      // the span IS the full key (`'absent.one'`) → the separate key is dropped.
      assert.doesNotMatch(out, /one' · absent\.one/, `${v}: key echo dropped`);
    }
    // FACT preserved: every row keeps its missingLocales (the flat sql/json stays per usage).
    const data = stripShapeTags(r.result.data) as { missing: { missingLocales: string[] }[] };
    assert.equal(data.missing.length, 2, 'json keeps both usages');
    assert.ok(
      data.missing.every((m) => m.missingLocales.includes('en')),
      'json keeps the missing locale on every row',
    );
    assertNoMetaLeak(r.result); // ~hideMissing must not leak
  } finally {
    await p.dispose();
  }
});

test('find_missing #2b: a NON-uniform missing-locale set is NOT hoisted — per-row stays', async () => {
  const p = await project({
    'tsconfig.json': TSCONFIG,
    'codemaster.config.ts':
      "import {defineConfig} from 'codemaster';\n" +
      "export default defineConfig({ i18n: { locales: ['locales/en.json','locales/ru.json'] } });\n",
    // `one` exists in en but not ru → missing in [ru]; `two` exists in neither → missing in [en,ru].
    'locales/en.json': JSON.stringify({ one: 'One' }),
    'locales/ru.json': JSON.stringify({}),
    'src/use.ts': "const t=(k:string)=>k;\nexport const a=t('one');\nexport const b=t('two');\n",
  });
  try {
    const r = await p.op('find_missing_i18n_keys', {});
    assert.ok('result' in r && r.result.ok, 'op ok');
    const out = renderResult(r.result, 'normal');
    assert.doesNotMatch(out, /on all 2 usage/, 'mixed sets → no hoisted header');
    assert.match(out, /missing in \[ru\]/, 'the [ru]-only row keeps its locale list');
    assert.match(out, /missing in \[en,ru\]/, 'the [en,ru] row keeps its locale list');
  } finally {
    await p.dispose();
  }
});

test('find_unused #3: span key-token echo dropped; per-row `· partial` dropped under a global demote', async () => {
  const p = await project({
    'tsconfig.json': TSCONFIG,
    'codemaster.config.ts': CONFIG,
    'locales/en.json': JSON.stringify({ widget: { add: 'Add' }, common: { cancel: 'Cancel' } }),
    // a headless dynamic t(k) demotes EVERY claim → globalDemote (verdict stated once in the note).
    'src/use.ts': 'const t=(k:string)=>k;\nexport const a=(k:string)=>t(k);\n',
  });
  try {
    const r = await p.op('find_unused_i18n_keys', { partials: 'list' });
    assert.ok('result' in r && r.result.ok, 'op ok');
    const data = stripShapeTags(r.result.data) as {
      globalDemote: boolean;
      unused: { key: string; confidence: string }[];
    };
    assert.equal(data.globalDemote, true, 'precondition: global demote');
    for (const v of VERBOSITIES) {
      const out = renderResult(r.result, v);
      assert.match(out, /· widget\.add\b/, `${v}: key shown`);
      assert.doesNotMatch(out, /"add"/, `${v}: span token echo dropped`);
      assert.doesNotMatch(out, /· partial\b/, `${v}: per-row partial dropped (verdict is global)`);
      // the global verdict is still stated once (the envelope demote flag + reason).
      assert.match(out, /globalDemote=true/, `${v}: global verdict kept`);
      assert.match(out, /cannot prove any key dead/, `${v}: demote reason kept`);
    }
    // FACT preserved: every row still carries confidence='partial' in json.
    assert.ok(
      data.unused.every((u) => u.confidence === 'partial'),
      'json keeps per-row confidence',
    );
    assertNoMetaLeak(r.result); // ~hideConf must not leak
  } finally {
    await p.dispose();
  }
});
