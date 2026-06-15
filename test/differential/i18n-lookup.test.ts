// i18n_lookup reverse (value→key) + locale scoping. The honesty invariant: a value query matches
// only SOME locales, but it must report the matched key's TRUE per-locale presence — never let the
// value filter make a key present everywhere read as "missing" (§3.6).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { project, type TestProject } from '../helpers/project.ts';

const TSCONFIG = '{"compilerOptions":{"strict":true}}';
const CONFIG =
  `import { defineConfig } from 'codemaster';\n` +
  `export default defineConfig({ i18n: { locales: ['locales/*.json'], functions: ['t'] } });\n`;
// profile.greeting present in BOTH locales with DIFFERENT values; only_en only in en.
const EN = JSON.stringify({ profile: { greeting: 'Hi' }, only_en: 'x' });
const DE = JSON.stringify({ profile: { greeting: 'Hallo' } });

function stdProject(): Promise<TestProject> {
  return project({
    'codemaster.config.ts': CONFIG,
    'tsconfig.json': TSCONFIG,
    'locales/en.json': EN,
    'locales/de.json': DE,
    'src/app.ts': `const t = (k: string): string => k;\nexport const a = t('profile.greeting');\n`,
  });
}

type Def = { key: string; locale: string; value: string };
const dataOf = (r: unknown): Record<string, unknown> =>
  (r as { result: { ok: boolean; data: Record<string, unknown> } }).result.data;

test('reverse value-lookup resolves the dotted key; missingPerKey reflects TRUE presence', async () => {
  const p = await stdProject();
  try {
    const data = dataOf(await p.op('i18n_lookup', { value: 'Hallo' })); // de value of profile.greeting
    const defs = data['defs'] as Def[];
    assert.ok(
      defs.some((d) => d.key === 'profile.greeting' && d.locale === 'de' && d.value === 'Hallo'),
      'a value resolves to its dotted key',
    );
    assert.ok(
      defs.some((d) => d.key === 'profile.greeting' && d.locale === 'en' && d.value === 'Hi'),
      'the matched key is shown across ALL locales, not just the value-matching one',
    );
    const missing = (data['missingPerKey'] as { key: string }[] | undefined) ?? [];
    assert.ok(
      !missing.some((m) => m.key === 'profile.greeting'),
      'present in en+de → never reported missing, though the value matched only de',
    );
  } finally {
    await p.dispose();
  }
});

test('locale filter emits one locale’s defs; missingPerKey stays global', async () => {
  const p = await stdProject();
  try {
    const defs = dataOf(await p.op('i18n_lookup', { key: 'profile.greeting', locale: 'de' }))[
      'defs'
    ] as Def[];
    assert.deepEqual([...new Set(defs.map((d) => d.locale))], ['de'], 'only de defs emitted');

    // only_en is defined only in en — still globally missing in de despite the locale filter.
    const data2 = dataOf(await p.op('i18n_lookup', { key: 'only_en', locale: 'en' }));
    const missing = (data2['missingPerKey'] as { key: string; missingLocales: string[] }[]) ?? [];
    assert.ok(
      missing.some((m) => m.key === 'only_en' && m.missingLocales.includes('de')),
      'missingPerKey is computed over all locales, not the scoped one',
    );
  } finally {
    await p.dispose();
  }
});
