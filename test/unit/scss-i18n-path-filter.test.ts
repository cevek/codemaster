// t-943264: three user-path-filter sites (scss unusedClasses, scss cascade inScope, i18n
// unusedKeys) used a RAW `matchesAnyGlob`, so a bare-dir `pathInclude`/`pathExclude` silently
// no-op'd (byte-identical to unfiltered) and a literal special-char dir had no working incantation
// — the same class the find_usages chokepoint fixed. Oracle: the explicit `dir/**` glob — a bare
// dir and a special-char dir must filter the SAME as `dir/**`, and DIFFER from unfiltered.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { project } from '../helpers/project.ts';
import type { JsonValue } from '../../src/core/json.ts';

type ScssView = { unused: { name: string; file: string }[] };
type I18nView = { unused: { key: string }[]; scanned: { keys: number } };
type CascadeView = { scanned: { sheets: number } };

test('find_unused_scss_classes: bare-dir + special-char pathInclude/Exclude filter like dir/**', async () => {
  const p = await project({
    'tsconfig.json': '{"compilerOptions":{"strict":true}}',
    'src/app/a.module.scss': '.deadA { color: red; }\n',
    'src/lib/b.module.scss': '.deadB { color: red; }\n',
    'src/(auth)/c.module.scss': '.deadC { color: red; }\n',
  });
  try {
    const names = async (filter: JsonValue): Promise<string[]> => {
      const r = await p.op('find_unused_scss_classes', filter);
      assert.ok('result' in r && r.result.ok, JSON.stringify(r));
      return (r.result.data as ScssView).unused.map((u) => u.name).sort();
    };

    const unfiltered = await names({});
    assert.deepEqual(unfiltered, ['deadA', 'deadB', 'deadC'], 'all three sheets report unfiltered');

    // Bare-dir pathExclude must drop src/lib — identical to the explicit glob, and NOT a no-op.
    const bareExc = await names({ pathExclude: ['src/lib'] });
    const globExc = await names({ pathExclude: ['src/lib/**'] });
    assert.deepEqual(bareExc, globExc, 'bare `src/lib` excludes the SAME as `src/lib/**`');
    assert.notDeepEqual(bareExc, unfiltered, 'the bare-dir exclude is NOT a silent no-op');
    assert.ok(!bareExc.includes('deadB'), 'no src/lib class survives the bare-dir exclude');

    // Literal special-char dir as an include filter — the (auth) route-group case.
    const special = await names({ pathInclude: ['src/(auth)'] });
    assert.deepEqual(special, ['deadC'], 'only the (auth) sheet survives the special-char include');
  } finally {
    await p.dispose();
  }
});

test('css_cascade: bare-dir pathExclude scopes the cross-sheet scan like dir/**', async () => {
  const p = await project({
    'tsconfig.json': '{"compilerOptions":{"strict":true}}',
    'src/main/base.module.scss': '.btn { color: red; }\n',
    'src/ext/over.module.scss': '.btn { color: blue; }\n',
  });
  try {
    const sheets = async (pathExclude: string[] | undefined): Promise<number> => {
      const r = await p.op('css_cascade', {
        file: 'src/main/base.module.scss',
        class: 'btn',
        ...(pathExclude !== undefined ? { pathExclude } : {}),
      });
      assert.ok('result' in r && r.result.ok, JSON.stringify(r));
      return (r.result.data as CascadeView).scanned.sheets;
    };

    assert.equal(await sheets(undefined), 2, 'unfiltered scans both contributing sheets');
    const bare = await sheets(['src/ext']);
    const glob = await sheets(['src/ext/**']);
    assert.equal(bare, glob, 'bare `src/ext` scopes the same as `src/ext/**`');
    assert.equal(bare, 1, 'the excluded contributor drops out (owning sheet still scanned)');
  } finally {
    await p.dispose();
  }
});

test('find_unused_i18n_keys: bare-dir pathExclude scopes reported keys like dir/**', async () => {
  const p = await project({
    'tsconfig.json': '{"compilerOptions":{"strict":true}}',
    'codemaster.config.ts':
      "import {defineConfig} from 'codemaster';\n" +
      "export default defineConfig({ i18n: { locales: ['locales/**/*.json'] } });\n",
    'locales/app/en.json': JSON.stringify({ appKey: 'A' }),
    'locales/lib/en.json': JSON.stringify({ libKey: 'B' }),
    'src/use.ts': 'const t = (k: string) => k;\nexport const x = 1;\n', // nothing used
  });
  try {
    const keys = async (filter: JsonValue): Promise<string[]> => {
      const r = await p.op('find_unused_i18n_keys', filter);
      assert.ok('result' in r && r.result.ok, JSON.stringify(r));
      return (r.result.data as I18nView).unused.map((u) => u.key).sort();
    };

    assert.deepEqual(await keys({}), ['appKey', 'libKey'], 'both locales report unfiltered');
    const bare = await keys({ pathExclude: ['locales/lib'] });
    const glob = await keys({ pathExclude: ['locales/lib/**'] });
    assert.deepEqual(bare, glob, 'bare `locales/lib` excludes the SAME as `locales/lib/**`');
    assert.deepEqual(bare, ['appKey'], 'the bare-dir exclude drops the lib locale (not a no-op)');
  } finally {
    await p.dispose();
  }
});
