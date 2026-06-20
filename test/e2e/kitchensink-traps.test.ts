// Trap-presence self-test for the synthetic `kitchensink` fixture (spec
// docs/spec-synthetic-fixture.md §6 gate 3 + gate 4). This is the fixture's OWN regression
// net: it asserts each matrix row is actually present and that codemaster behaves HONESTLY
// over it — against REAL op output (the live LS / scss / i18n tiers), never "the file
// contains X". If a future cleanup deletes or weakens a trap, an assertion here fails.
//
// It pins CURRENT codemaster behavior. The three scss/css-module honesty gaps the fixture once
// surfaced (contextual-selector classes reported `certain` unused; no BEM `&__el` synthesis;
// `:global()` not excluded) were closed by spec-scss-css-honesty — the §4.3.1 test below now
// asserts the corrected behavior.

// Gate 1 (the cold `tsc --noEmit` over the fixture) lives in kitchensink-tsc.test.ts.
// (Stage 4 oracle-hardening lives in the sibling kitchensink-oracle-hardening.test.ts — the
// 300-line-per-file cap (CONTRIBUTING) forced the split; spec §5 Stage 4's "extend
// kitchensink-traps.test.ts" is satisfied by that clearly-linked companion file.)
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { projectFromDir } from '../helpers/repo-fixture.ts';
import { assertSpansValid, type TestProject } from '../helpers/project.ts';
import type { OpResult } from '../../src/ops/contracts.ts';

// Narrow an OpResult to its success payload, asserting ok along the way.
function okData(r: OpResult): Record<string, unknown> {
  assert.ok('result' in r, `dispatch error: ${JSON.stringify(r)}`);
  assert.ok(r.result.ok, `op failed: ${JSON.stringify(r.result)}`);
  return r.result.data as Record<string, unknown>;
}

// `file:role` set — a single-role filter HOISTS role to a header (item 4), so read `u.role ?? all`.
function usageSet(r: OpResult): Set<string> {
  const d = okData(r) as { usages: { span: { file: string }; role?: string }[]; role?: string };
  return new Set(d.usages.map((u) => `${u.span.file}:${u.role ?? d.role}`));
}

void describe('kitchensink trap-presence (§6 gate 3/4)', () => {
  let p: TestProject;
  before(async () => {
    p = await projectFromDir('kitchensink');
  });
  after(async () => {
    await p.dispose();
  });

  test('gate 2 — status lists ts, scss AND i18n with the full op catalogue', async () => {
    const status = await p.status();
    assert.match(status, /plugins:.*\bts\b/);
    assert.match(status, /plugins:.*\bscss\b/);
    assert.match(status, /plugins:.*\bi18n\b/);
    for (const op of ['search_symbol', 'find_usages', 'scss_classes', 'i18n_lookup']) {
      assert.ok(status.includes(op), `status must document op ${op}`);
    }
  });

  test('T2 — high-fan-in formatLabel: ≥6 usage sites across ≥4 files (through re-exports)', async () => {
    const r = await p.op('find_usages', { name: 'formatLabel' });
    const data = okData(r);
    const usages = data['usages'] as { span: { file: string }; role: string }[];
    const callFiles = new Set(usages.filter((u) => u.role === 'call').map((u) => u.span.file));
    assert.ok(callFiles.size >= 4, `expected ≥4 calling files, got ${callFiles.size}`);
    assert.ok((data['total'] as number) >= 6, `expected ≥6 total, got ${data['total'] as number}`);
    // M4 — resolves through the 3-hop re-export chain (a/b/c) and the hub barrel.
    const allFiles = new Set(usages.map((u) => u.span.file));
    assert.ok(allFiles.has('src/shared/chain/a.ts'), 'must resolve through the deep chain');
    assertSpansValid(p.root, r);
  });

  test('T3 — high-fan-in Registry class: instantiated across ≥5 files', async () => {
    const r = await p.op('find_usages', { name: 'Registry', role: 'call' });
    const data = okData(r);
    const files = new Set((data['usages'] as { span: { file: string } }[]).map((u) => u.span.file));
    assert.ok(files.size >= 5, `expected Registry instantiated in ≥5 files, got ${files.size}`);
  });

  test('T4 — 3-way `handle` collision: find_definition reports ambiguity, never guesses', async () => {
    const r = await p.op('find_definition', { name: 'handle' });
    assert.ok('result' in r);
    assert.equal(r.result.ok, false, 'an ambiguous name must NOT silently resolve to one');
    if (!r.result.ok) {
      assert.match(r.result.failure.message, /ambiguous/);
      assert.match(r.result.failure.message, /3 distinct declarations/);
    }
  });

  test('T1/T10 — expand_type covers the real enum AND the string-literal union', async () => {
    const sev = okData(await p.op('expand_type', { name: 'Severity' }));
    const members = (sev['members'] as { name: string }[]).map((m) => m.name);
    assert.deepEqual(members, ['Low', 'Medium', 'High']);

    const status = okData(await p.op('expand_type', { name: 'Status' }));
    // Small union: the head lists every arm verbatim, so `constituents` is suppressed (density).
    const head = (status['type'] ?? status['about']) as string;
    assert.match(head, /"idle".*"loading".*"ready".*"error"/, 'arms in head');
    assert.equal(status['constituents'], undefined, 'constituents suppressed');
  });

  test('M11 — dual-spelling import resolves both spellings to ONE importer set', async () => {
    const data = okData(await p.op('importers_of', { module: '@/lib/util' }));
    const at = (data['importers'] as { at: string }[]).map((i) => i.at.split(':')[0]);
    assert.ok(
      at.includes('src/features/misc/anchors.ts'),
      'the `@/lib/util.ts` (extension) importer must resolve',
    );
    assert.ok(
      at.includes('src/features/misc/Showcase.tsx'),
      'the `@/lib/util` (no-extension) importer must resolve to the SAME module',
    );
  });

  test('S1/S6 — scss_classes lists .scss AND .module.css classes (index ⟷ usage scanner agree)', async () => {
    const r = await p.op('scss_classes', {});
    const data = okData(r);
    const names = new Set((data['classes'] as { name: string }[]).map((c) => c.name));
    assert.ok(names.has('card') && names.has('container'), 'simple module classes must be listed');
    // S6 — .module.css IS parsed now (plain postcss), so a used class can be matched.
    assert.ok(names.has('panelBox'), '.module.css classes are listed by scss');
    assertSpansValid(p.root, r); // every scss class span must equal the source on disk
  });

  test('S7/S10 — broken .scss AND indented .sass each surface an honest per-file parse failure', async () => {
    const data = okData(await p.op('scss_classes', {}));
    const failures = data['parseFailures'] as { file: string; message: string }[];
    assert.ok(
      failures.some((f) => f.file === 'src/styles/broken.scss' && /[Uu]nclosed/.test(f.message)),
      'broken.scss must surface a parse failure honestly',
    );
    // S7 — indented .sass isn't postcss-scss (brace) syntax → parseFailure, never a silent skip.
    assert.ok(
      failures.some((f) => f.file.endsWith('legacy.sass')),
      'indented .sass → parseFailure',
    );
  });

  test('S4/S5/S9 — find_unused_scss honesty: certain-unused vs partial (computed/interpolated)', async () => {
    const data = okData(await p.op('find_unused_scss_classes', {}));
    const unused = data['unused'] as { name: string; file: string; confidence: string }[];
    // file-specific lookup — class names (e.g. `active`) recur across modules.
    const conf = (name: string, fileFrag: string): string | undefined =>
      unused.find((u) => u.name === name && u.file.includes(fileFrag))?.confidence;
    // S4 — genuinely-unused simple classes are reported with certainty.
    assert.equal(conf('unusedGrid', 'grid.module.scss'), 'certain');
    assert.equal(conf('unusedTheme', 'theme.module.scss'), 'certain');
    // S5/S13 — a class in a module with computed access cannot be proven dead → partial.
    assert.equal(conf('variant-a', 'table.module.scss'), 'partial');
    assert.equal(conf('variant-b', 'table.module.scss'), 'partial');
    // S9 — `icon-` is in the FLAT global `base.scss` → partial (interpolation→partial in a MODULE
    // context is covered by scss-confidence.ts).
    assert.equal(conf('icon-', 'base.scss'), 'partial');
  });

  test('I2 — find_missing_i18n_keys flags the used-but-undeclared key; dynamic key flagged apart', async () => {
    const data = okData(await p.op('find_missing_i18n_keys', {}));
    const missing = data['missing'] as { key: string }[];
    assert.ok(
      missing.some((m) => m.key === 'absent.key'),
      'absent.key must be flagged missing',
    );
    // The template-literal `t(`dashboard.${x}`)` is unresolvable, listed separately, never guessed.
    assert.ok(Array.isArray(data['dynamicUsages']) && (data['dynamicUsages'] as []).length >= 1);
  });

  test('I3 — find_unused_i18n_keys flags the orphan key', async () => {
    const data = okData(await p.op('find_unused_i18n_keys', {}));
    const unused = data['unused'] as { key: string }[];
    assert.ok(
      unused.some((u) => u.key === 'orphan.neverUsed'),
      'declared-never-used key is orphan',
    );
  });

  test('I1 — i18n_lookup resolves a key across locales and reports en-only as missing-in-ru', async () => {
    const r = await p.op('i18n_lookup', { key: 'onlyInEn.missingInRu' });
    const data = okData(r);
    const locales = (data['defs'] as { locale: string }[]).map((d) => d.locale);
    assert.ok(locales.includes('en'), 'the key is defined in en');
    assert.ok(!locales.includes('ru'), 'the key is absent in ru (the I3 missing-locale trap)');
    assertSpansValid(p.root, r); // locale key spans must equal the JSON on disk
  });

  // ---- §4.1 module-resolution rows (presence net — gate 3 "can't silently lose a trap") ----

  test('M1 — alias (@/…) imports resolve (importers_of through tsconfig paths)', async () => {
    const data = okData(await p.op('importers_of', { module: '@/core/format.ts' }));
    assert.ok(
      (data['importers'] as unknown[]).length >= 4,
      'the @/ alias must resolve to importers',
    );
  });

  test('M2/M4 — barrel + 3-hop chain: formatLabel carries a reexport role through c→a + the hub', async () => {
    const set = usageSet(await p.op('find_usages', { name: 'formatLabel', role: 'reexport' }));
    assert.ok(set.has('src/shared/chain/c.ts:reexport'), 'chain hop 1 (decl→c) is a reexport');
    assert.ok(set.has('src/shared/chain/a.ts:reexport'), 'chain hop 3 (b→a) is a reexport');
    assert.ok(set.has('src/shared/index.ts:reexport'), 'the hub barrel re-exports it too');
  });

  test('M3 — aliased re-export consumed as <Card/> JSX (and formatLabel as fmt() call)', async () => {
    const widget = usageSet(await p.op('find_usages', { name: 'Widget' }));
    assert.ok(widget.has('src/shared/index.ts:reexport'), 'Widget re-exported as Card (rename)');
    assert.ok(
      widget.has('src/features/misc/Showcase.tsx:jsx'),
      'the renamed <Card/> is a JSX usage',
    );
    // the import-with-rename `fmt` call resolves back to formatLabel in Showcase.
    const fmt = usageSet(await p.op('find_usages', { name: 'formatLabel' }));
    assert.ok(fmt.has('src/features/misc/Showcase.tsx:call'), 'fmt(...) resolves to formatLabel');
  });

  test('M5 — namespace import: NS.alpha() call resolves through the namespace', async () => {
    const set = usageSet(await p.op('find_usages', { name: 'alpha' }));
    assert.ok(set.has('src/features/forms/Form.tsx:call'), 'NS.alpha() must be found as a call');
  });

  test('M6 — default export consumed by default import', async () => {
    const set = usageSet(await p.op('find_usages', { name: 'submit' }));
    assert.ok(
      [...set].some((k) => k.startsWith('src/features/forms/Form.tsx')),
      'the default-imported submit must resolve to Form.tsx',
    );
  });

  test('M7/T7 — Foo is referenced ONLY in type positions (never as a value)', async () => {
    const usages = okData(await p.op('find_usages', { name: 'Foo' }))['usages'] as {
      role: string;
    }[];
    const roles = new Set(usages.map((u) => u.role));
    assert.ok(!roles.has('call'), 'a type-only symbol must have no call role');
    assert.ok(roles.has('type'), 'Foo must be observed in a type position');
  });

  test('M8 — import cycle (panel ↔ table) resolves both directions without hanging', async () => {
    const rowCount = usageSet(await p.op('find_usages', { name: 'rowCount' }));
    assert.ok(rowCount.has('src/features/panel/Panel.tsx:call'), 'Panel calls into Table');
    const panelTitle = usageSet(await p.op('find_usages', { name: 'panelTitle' }));
    assert.ok(panelTitle.has('src/features/table/Table.tsx:call'), 'Table calls back into Panel');
  });

  test('M9 — dynamic import() / React.lazy registry is present', async () => {
    const data = okData(await p.op('search_symbol', { query: 'lazyRegistry' }));
    assert.ok(
      (data['matches'] as { name: string }[]).some((m) => m.name === 'lazyRegistry'),
      'the string-keyed lazy registry (dynamic import specifiers) must exist',
    );
  });

  test('M12 — import("@/data/shapes").Bar type-query resolves (ES-import analysis alone misses it)', async () => {
    const r = await p.op('find_usages', { name: 'Bar' });
    const set = usageSet(r);
    assert.ok(set.has('src/core/io.ts:type'), 'Bar via import().Type in a signature resolves');
    assert.ok(set.has('src/features/forms/Form.tsx:type'), 'and in the second consumer too');
    assertSpansValid(p.root, r); // type-query proof spans must equal the source
  });

  // ---- §4.2 TS symbol & call-site tangle ----

  test('T5 — indirect call (const f = fn) + callback passing both resolve to validate', async () => {
    const set = usageSet(await p.op('find_usages', { name: 'validate' }));
    const inForm = [...set].filter((k) => k.startsWith('src/features/forms/Form.tsx'));
    assert.ok(inForm.length >= 1, 'validate must be observed in Form (indirect + callback)');
  });

  test('T6 — overloaded function + merged namespace both resolve via find_definition', async () => {
    const coerce = await p.op('find_definition', { name: 'coerce' });
    assert.ok('result' in coerce && coerce.result.ok, 'overloaded coerce resolves');
    const box = await p.op('find_definition', { name: 'box' });
    assert.ok('result' in box && box.result.ok, 'function/namespace-merged box resolves');
  });

  test('T8 — namespaced JSX <UI.Button/> resolves to the component', async () => {
    const set = usageSet(await p.op('find_usages', { name: 'Button' }));
    assert.ok(set.has('src/features/misc/Showcase.tsx:jsx'), 'namespaced JSX usage must be found');
  });

  test('T9 — move/delete anchors each have a clear consumer (rebind substrate)', async () => {
    const mv = usageSet(await p.op('find_usages', { name: 'movableAnchor' }));
    assert.ok(mv.has('src/features/misc/Showcase.tsx:call'), 'movable anchor has a consumer');
    const del = usageSet(await p.op('find_usages', { name: 'deletableAnchor' }));
    assert.ok(del.has('src/features/misc/Showcase.tsx:call'), 'deletable anchor has a consumer');
  });

  test('T11 — ambient module (virtual:config) is a non-relocatable module, not a file', async () => {
    const data = okData(await p.op('importers_of', { module: 'virtual:config' }));
    // It resolves importers but the module stays the bare specifier — it is NOT a repo file.
    assert.equal(
      data['module'],
      'virtual:config',
      'ambient module must not resolve to a file path',
    );
    assert.ok((data['importers'] as { at: string }[]).some((i) => i.at.includes('Showcase.tsx')));
  });

  test('T12 — the large monolithic file exposes its nested extract anchor', async () => {
    const data = okData(await p.op('search_symbol', { query: 'buildReport' }));
    assert.ok(
      (data['matches'] as { file?: string; span?: { file: string } }[]).some(
        (m) => (m.span?.file ?? m.file) === 'src/features/misc/mono.ts',
      ),
      'the closure-capturing extract anchor (buildReport) must be discoverable',
    );
  });

  test('T13 — const-enum member refs resolve across ≥2 files (members inlined)', async () => {
    const set = usageSet(await p.op('find_usages', { name: 'Code' }));
    const files = new Set([...set].map((k) => k.slice(0, k.lastIndexOf(':'))));
    assert.ok(
      files.size >= 3,
      'Code is referenced from the decl + dashboard + forms (≥2 consumers)',
    );
  });

  // ---- §4.3 style rows (presence) + KNOWN-GAP pins (filed via feedback) ----

  test('S2/S3/S8 — side-effect scss is class-listed; ≥3 dashboard modules; global .css indexed', async () => {
    const classes = okData(await p.op('scss_classes', {}))['classes'] as {
      name: string;
      file: string;
    }[];
    const names = new Set(classes.map((c) => c.name));
    // S2 — the bare side-effect stylesheet's classes are still listed by scss_classes.
    assert.ok(names.has('global-widget-frame'), 'w.scss (side-effect) classes are listed');
    // S3 — three distinct dashboard module files contribute classes.
    const dashFiles = new Set(
      classes.filter((c) => c.file.includes('dashboard/')).map((c) => c.file),
    );
    assert.ok(dashFiles.size >= 3, 'Dashboard pulls ≥3 css modules');
    // S8 — the global .css IS indexed, but referenced via string classNames → demoted to partial,
    // never a false certain dead (global .scss demotion is pinned in scss-css-sass-index.ts).
    const unused = okData(await p.op('find_unused_scss_classes', {}))['unused'] as {
      name: string;
      confidence: string;
    }[];
    const themeRoot = unused.find((u) => u.name === 'theme-root');
    assert.equal(themeRoot?.confidence, 'partial', 'a global .css class is never certain unused');
  });

  test('S12/S13 — composes class listed; static indirection-map classes counted USED', async () => {
    const names = new Set(
      (okData(await p.op('scss_classes', {}))['classes'] as { name: string }[]).map((c) => c.name),
    );
    assert.ok(names.has('composed'), 'the composes: class is present');
    // S13(b) — alpha/beta are referenced via a static `as const` map literal → counted used.
    const unused = (
      okData(await p.op('find_unused_scss_classes', {}))['unused'] as {
        name: string;
        file: string;
      }[]
    ).filter((u) => u.file.includes('table.module.scss'));
    const unusedNames = new Set(unused.map((u) => u.name));
    assert.ok(!unusedNames.has('alpha'), 'alpha (static map ref) must not read as unused');
    assert.ok(!unusedNames.has('beta'), 'beta (static map ref) must not read as unused');
  });

  test('S11/§4.3.1 — scss/css-module honesty (spec-scss-css-honesty Stages 1-2)', async () => {
    // Flipped from the former KNOWN-GAP pins now that spec-scss-css-honesty landed: the
    // synthesis / exclusion / contextual-honesty behaviors the fixture exercises are asserted
    // as the CORRECT behavior. Oracle = the live scss tier over the fixture.
    const names = new Set(
      (okData(await p.op('scss_classes', {}))['classes'] as { name: string }[]).map((c) => c.name),
    );
    // Stage 2: :global(.escapeHatch) breaks out of module scope → NOT a module-local class.
    assert.ok(!names.has('escapeHatch'), ':global() class is excluded from the module-local set');
    // Stage 2: BEM parent-ref concat is synthesized so `s['block__el']` can match.
    assert.ok(names.has('block__el'), '&__el resolves to the flat class block__el');
    assert.ok(names.has('block--mod'), '&--mod resolves to block--mod');
    assert.ok(names.has('block'), 'the parent selector itself is still extracted');
    // Stage 1: a class existing ONLY in a contextual selector can't be proven dead → partial,
    // and the duplicate selectors collapse to a SINGLE unused row.
    const unused = okData(await p.op('find_unused_scss_classes', {}))['unused'] as {
      name: string;
      file: string;
      confidence: string;
    }[];
    // §4.3.1 contextual zoo (descendant/child/nested/attribute-context/at-rule): every such
    // class is `partial`, never `certain` unused; `nested`'s duplicate selectors dedup to one.
    const rows = (name: string): { confidence: string }[] =>
      unused.filter((u) => u.name === name && u.file.includes('Widget.module.scss'));
    assert.equal(rows('nested').length, 1, 'duplicate contextual rows collapse to one');
    for (const name of ['nested', 'row', 'head', 'themed', 'responsive']) {
      assert.equal(rows(name)[0]?.confidence, 'partial', `contextual-only \`${name}\` is partial`);
    }
  });
});
