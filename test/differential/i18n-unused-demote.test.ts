// Prefix-scoped dynamic demotion (backlog I-a, §3.6). The §16 oracle is a hand-built scenario:
// several locale namespaces + a SINGLE dynamic `t(`errors.codes.${x}`)`. That template can only
// ever resolve under `errors.codes.` — so it demotes THAT namespace to `partial`, while the
// genuinely-dead keys in unrelated namespaces must stay PROVABLE (`certain`) and visible. The old
// behaviour buried the whole scan in `partial`; the win is the dead tail surviving one dynamic key.
//
// Invariant 3 (cold == warm) rides along: a warm-reindexed answer over the full key×confidence set
// (partials:'list') must equal a cold boot over the identical tree — a drift in WHICH keys are
// partial (the prefix-scoping logic) would fail here even at an equal count.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { project } from '../helpers/project.ts';
import type { OpResult } from '../../src/ops/contracts.ts';

const TSCONFIG = '{"compilerOptions":{"strict":true}}';
const CONFIG =
  "import {defineConfig} from 'codemaster';\n" +
  "export default defineConfig({ i18n: { locales: ['locales/en.json'] } });\n";
const LOCALE = JSON.stringify({
  errors: { codes: { e1: 'X', e2: 'Y' }, fatal: 'Z' },
  ui: { ok: 'OK', cancel: 'Cancel' },
  common: { save: 'Save' },
});
// `ui.ok` is statically used; the dynamic template demotes only `errors.codes.*`.
const USE =
  'const t = (k: string) => k;\n' +
  "const x = 'e1';\n" +
  "export const a = t('ui.ok');\n" +
  'export const b = t(`errors.codes.${x}`);\n';

type Row = { key: string; confidence: string };
type View = {
  unused: Row[];
  degraded: boolean;
  globalDemote: boolean;
  demotedPrefixes?: string[];
  partial?: { count: number; demoted?: 'global' | string[] };
};

function okView(r: OpResult): View {
  assert.ok('result' in r && r.result.ok, JSON.stringify(r));
  return r.result.data as View;
}

test('demote: a dynamic errors.codes.${x} demotes ONLY that namespace; the dead tail stays certain', async () => {
  const p = await project({
    'tsconfig.json': TSCONFIG,
    'codemaster.config.ts': CONFIG,
    'locales/en.json': LOCALE,
    'src/use.ts': USE,
  });
  try {
    // Default (summary): certain-dead keys listed; partials collapsed to a named summary.
    const def = okView(await p.op('find_unused_i18n_keys', {}));
    assert.equal(def.degraded, true);
    assert.equal(def.globalDemote, false, 'a scoped demotion is NOT global');
    assert.deepEqual(
      def.unused.map((u) => u.key).sort(),
      ['common.save', 'errors.fatal', 'ui.cancel'],
      'the genuinely-dead tail in unrelated namespaces is visible and certain',
    );
    assert.ok(def.unused.every((u) => u.confidence === 'certain'));
    assert.equal(def.partial?.count, 2, 'both errors.codes.* keys collapse to the summary');
    assert.deepEqual(def.partial?.demoted, ['errors.codes.'], 'the demoted namespace is named');

    // partials:'hide' (the certain-only flag) — just the dead tail, no per-key partial noise.
    const hide = okView(await p.op('find_unused_i18n_keys', { partials: 'hide' }));
    assert.deepEqual(hide.unused.map((u) => u.key).sort(), [
      'common.save',
      'errors.fatal',
      'ui.cancel',
    ]);
    assert.equal(hide.partial?.count, 2);
    assert.equal(hide.partial?.demoted, undefined, 'hide keeps only the count, no namespace block');

    // partials:'list' — every key with its true confidence (the full set the oracle pins).
    const list = okView(await p.op('find_unused_i18n_keys', { partials: 'list' }));
    const byKey = new Map(list.unused.map((u) => [u.key, u.confidence]));
    assert.deepEqual(
      [...byKey.entries()].sort(),
      [
        ['common.save', 'certain'],
        ['errors.codes.e1', 'partial'],
        ['errors.codes.e2', 'partial'],
        ['errors.fatal', 'certain'],
        ['ui.cancel', 'certain'],
      ],
      'errors.codes.* partial; everything else certain — ui.ok is used (absent)',
    );
  } finally {
    await p.dispose();
  }
});

test('demote: a transforming wrapper rooted in a template demotes GLOBALLY (no false certain)', async () => {
  // `t(`UI.${k}`.toLowerCase())` STARTS with a backtick but its runtime value is `ui.<k>` — it
  // need NOT start with the static head `UI.`. Trusting the head would read a USED key certain-dead
  // (a lie). The whole-argument-must-be-a-bare-template guard demotes globally instead.
  const p = await project({
    'tsconfig.json': TSCONFIG,
    'codemaster.config.ts': CONFIG,
    'locales/en.json': JSON.stringify({ ui: { ok: 'OK' }, errors: { fatal: 'Z' } }),
    'src/use.ts':
      "const t = (k: string) => k;\nconst k = 'ok';\nexport const a = t(`UI.${k}`.toLowerCase());\n",
  });
  try {
    const v = okView(await p.op('find_unused_i18n_keys', { partials: 'list' }));
    assert.equal(v.globalDemote, true, 'a transforming wrapper is not a provable prefix → global');
    assert.ok(
      v.unused.every((u) => u.confidence === 'partial'),
      'ui.ok (genuinely reachable via the transform) is NEVER reported certain-dead',
    );
  } finally {
    await p.dispose();
  }
});

test('demote: cold == warm over the full key×confidence set after an incremental edit', async () => {
  const initial = {
    'tsconfig.json': TSCONFIG,
    'codemaster.config.ts': CONFIG,
    'locales/en.json': LOCALE,
    'src/use.ts': USE,
  };
  // Add a new dead key in an unrelated namespace — it must read certain in BOTH cold and warm.
  const finalLocale = JSON.stringify({
    errors: { codes: { e1: 'X', e2: 'Y' }, fatal: 'Z' },
    ui: { ok: 'OK', cancel: 'Cancel' },
    common: { save: 'Save', reset: 'Reset' },
  });

  const facts = (r: OpResult): [string, string][] =>
    okView(r)
      .unused.map((u): [string, string] => [u.key, u.confidence])
      .sort();

  // Warm: boot, baseline query (pins the freshness guard), edit the locale, query again.
  const warmP = await project(initial);
  let warm: [string, string][];
  try {
    await warmP.op('find_unused_i18n_keys', { partials: 'list' });
    warmP.write('locales/en.json', finalLocale);
    const op2 = await warmP.op('find_unused_i18n_keys', { partials: 'list' });
    assert.ok('result' in op2 && op2.result.ok);
    assert.ok(
      (op2.result.freshness?.reindexed ?? 0) >= 1,
      'the warm path must reindex incrementally — otherwise it is a disguised cold boot',
    );
    warm = facts(op2);
  } finally {
    await warmP.dispose();
  }

  // Cold: boot over the identical final tree, query once.
  const coldP = await project({ ...initial, 'locales/en.json': finalLocale });
  let cold: [string, string][];
  try {
    cold = facts(await coldP.op('find_unused_i18n_keys', { partials: 'list' }));
  } finally {
    await coldP.dispose();
  }

  assert.deepEqual(warm, cold, 'an incrementally-patched i18n plugin must match a cold rebuild');
  assert.ok(
    warm.some(([k, c]) => k === 'common.reset' && c === 'certain'),
    'the added key is certain-dead in both',
  );
});
