// Two identity-scan honesty fixes (backlog I-b, I-f), each on a MINIMAL hand-curated fixture so
// the oracle is the fixture itself (cold reparse of the locale JSON + the TS scan, never grep,
// never golden-only — §16).
//
//  • I-b — WITHIN-FILE SHADOWING must not FABRICATE. The identity scan matches a callee by local
//    name; a function PARAMETER named `t` shadows the import-bound `t` inside its body, so its call
//    is the local param, NOT the i18n function. Counting it would fabricate a use of the key it
//    passes (mis-marking a dead key as used) and a find_missing row for an absent key. The fix
//    gates the match through scope-shadow (the nearest binding is the param, not the import).
//
//  • I-f — a NO-SUBSTITUTION template `t(`a.b`)` is a STATIC literal, not dynamic. Classifying it
//    dynamic drops a determinate use AND demotes the whole `a.b*` namespace to partial. The fix
//    reads it as the static key it provably is (an interpolated `t(`a.${x}`)` stays dynamic).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { project } from '../helpers/project.ts';

const TSCONFIG = JSON.stringify({
  compilerOptions: {
    strict: true,
    baseUrl: '.',
    paths: { '@/*': ['src/*'] },
    module: 'esnext',
    moduleResolution: 'bundler',
  },
});

// Identity config: the i18n function is anchored to its module (so by-IDENTITY matching is active).
const CONFIG =
  `import { defineConfig } from 'codemaster';\n` +
  `export default defineConfig({ i18n: { locales: ['locales/*.json'], module: '@/lib/i18n' } });\n`;

// The real i18n module: a bare `t` export.
const LIB = `export function t(key: string): string {\n  return key;\n}\n`;

type Unused = { key: string; confidence: string };

const data = (res: unknown): Record<string, unknown> =>
  (res as { result: { data: Record<string, unknown> } }).result.data;
const unusedKeys = (d: Record<string, unknown>): string[] =>
  ((d['unused'] as Unused[]) ?? []).map((u) => u.key).sort();

test('I-b: a param `t` shadowing the import-bound t does NOT fabricate a usage', async () => {
  // `live` is used by the real import-bound t; `shadowed` is referenced ONLY by a param `t`, so it
  // MUST stay unused; `absent.key` is referenced ONLY by the param `t`, so it MUST NOT be missing.
  const p = await project({
    'codemaster.config.ts': CONFIG,
    'tsconfig.json': TSCONFIG,
    'locales/en.json': JSON.stringify({ live: 'L', shadowed: 'S', dead: 'D' }),
    'src/lib/i18n.ts': LIB,
    'src/app.ts':
      `import { t } from '@/lib/i18n';\n` +
      `export const real = t('live');\n` +
      `export function f(t: (k: string) => string): string {\n` +
      `  return t('shadowed') + t('absent.key');\n` + // the LOCAL param — not the i18n t
      `}\n`,
  });
  try {
    const ud = data(await p.op('find_unused_i18n_keys', {}));
    assert.deepEqual(
      unusedKeys(ud),
      ['dead', 'shadowed'],
      'param `t` does not rescue `shadowed` — it is the local param, not the i18n t',
    );
    assert.equal(ud['degraded'], false, 'static calls only — no demotion');

    const md = data(await p.op('find_missing_i18n_keys', {}));
    const missing = (md['missing'] as { key: string }[]) ?? [];
    assert.equal(
      missing.find((m) => m.key === 'absent.key'),
      undefined,
      'param `t("absent.key")` is not an i18n usage — no fabricated missing row',
    );
  } finally {
    await p.dispose();
  }
});

test('I-f: a no-substitution template t(`key`) is a STATIC use, not dynamic', async () => {
  // `tpl` is referenced ONLY by a backtick literal with no interpolation — a static, determinate
  // key. It must count as a use (so only `dead` is unused) and must NOT demote the scan to partial.
  const p = await project({
    'codemaster.config.ts': CONFIG,
    'tsconfig.json': TSCONFIG,
    'locales/en.json': JSON.stringify({ tpl: 'T', dead: 'D' }),
    'src/lib/i18n.ts': LIB,
    'src/app.ts': `import { t } from '@/lib/i18n';\nexport const b = t(\`tpl\`);\n`,
  });
  try {
    const ud = data(await p.op('find_unused_i18n_keys', {}));
    assert.deepEqual(
      unusedKeys(ud),
      ['dead'],
      't(`tpl`) is a static use of tpl — only dead stays unused',
    );
    assert.equal(ud['degraded'], false, 'a no-sub template is static — no dynamic demotion');
  } finally {
    await p.dispose();
  }
});

test('I-f: an INTERPOLATED template t(`a.${x}`) stays dynamic (the fix is surgical)', async () => {
  // Guard the boundary: the no-sub fix must not bleed into interpolated templates — `t(`x.${b}`)`
  // is a TemplateExpression, still dynamic, and still demotes its `x.` namespace (backlog I-a).
  const p = await project({
    'codemaster.config.ts': CONFIG,
    'tsconfig.json': TSCONFIG,
    'locales/en.json': JSON.stringify({ 'x.one': '1', dead: 'D' }),
    'src/lib/i18n.ts': LIB,
    'src/app.ts': `import { t } from '@/lib/i18n';\nconst b = 1;\nexport const v = t(\`x.\${b}\`);\n`,
  });
  try {
    const ud = data(await p.op('find_unused_i18n_keys', {}));
    assert.equal(ud['degraded'], true, 'an interpolated template is still dynamic');
    assert.equal(ud['globalDemote'], false, 'a scoped head `x.` demotes only that namespace');
    assert.deepEqual(
      unusedKeys(ud),
      ['dead'],
      'x.one is demoted under the dynamic head; only the unrelated `dead` stays certain',
    );
    const partial = ud['partial'] as { demoted?: string[] } | undefined;
    assert.deepEqual(
      partial?.demoted,
      ['x.'],
      'the interpolated static head `x.` scopes the demotion',
    );
  } finally {
    await p.dispose();
  }
});
