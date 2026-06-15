// find_unused_i18n_keys scoping (prefix / pathInclude / pathExclude). The whole-locale answer
// caps fast on a real key set, so the op must narrow. Load-bearing invariant (mirrors the scss
// filter): scoping selects which keys are REPORTED — it must NOT upgrade a globally-demoted key
// to a false `certain` dead, because the `degraded` verdict reflects the WHOLE usage scan (a
// dynamic t(`…`) anywhere). Oracle = hand-built expectations over an inline-VFS locale.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { project } from '../helpers/project.ts';

type Unused = { key: string; confidence: string };
type View = { unused: Unused[]; degraded: boolean; scanned: { keys: number; usages: number } };

const TSCONFIG = '{"compilerOptions":{"strict":true}}';
const CONFIG =
  "import {defineConfig} from 'codemaster';\n" +
  "export default defineConfig({ i18n: { locales: ['locales/en.json'] } });\n";
const LOCALE = JSON.stringify({
  errors: { a: 'A', b: 'B' },
  common: { ok: 'OK', cancel: 'Cancel' },
});

test('find_unused_i18n_keys: prefix + path scoping, with honest scanned.keys', async () => {
  const p = await project({
    'tsconfig.json': TSCONFIG,
    'codemaster.config.ts': CONFIG,
    'locales/en.json': LOCALE,
    // static t('common.ok') → used; no dynamic call → claims are crisp (certain).
    'src/use.ts': "const t = (k: string) => k;\nexport const x = t('common.ok');\n",
  });
  try {
    const all = await p.op('find_unused_i18n_keys', {});
    assert.ok('result' in all && all.result.ok);
    const allView = all.result.data as View;
    assert.equal(allView.degraded, false, 'no dynamic call → not degraded');
    assert.deepEqual(
      allView.unused.map((u) => u.key).sort(),
      ['common.cancel', 'errors.a', 'errors.b'],
      'common.ok is used; the rest are unused',
    );
    assert.equal(allView.scanned.keys, 4, 'four distinct keys in the locale');
    assert.ok(
      allView.unused.every((u) => u.confidence === 'certain'),
      'crisp → certain',
    );

    // prefix scopes to one namespace; scanned.keys shrinks to the scoped set.
    const pref = await p.op('find_unused_i18n_keys', { prefix: 'errors' });
    assert.ok('result' in pref && pref.result.ok);
    const prefView = pref.result.data as View;
    assert.deepEqual(prefView.unused.map((u) => u.key).sort(), ['errors.a', 'errors.b']);
    assert.equal(prefView.scanned.keys, 2, 'scanned scope = the errors.* namespace');

    // pathExclude drops the only locale → nothing in scope.
    const exc = await p.op('find_unused_i18n_keys', { pathExclude: ['**/en.json'] });
    assert.ok('result' in exc && exc.result.ok);
    const excView = exc.result.data as View;
    assert.equal(excView.unused.length, 0);
    assert.equal(excView.scanned.keys, 0, 'the only locale is excluded');
  } finally {
    await p.dispose();
  }
});

test('find_unused_i18n_keys: a dynamic t(`…`) demotes globally — scoping never upgrades to certain', async () => {
  const p = await project({
    'tsconfig.json': TSCONFIG,
    'codemaster.config.ts': CONFIG,
    'locales/en.json': LOCALE,
    // a dynamic (template-literal) call anywhere → every unused-claim is partial (§3.3).
    'src/use.ts':
      "const t = (k: string) => k;\nconst d = 'x';\nexport const y = t(`common.${d}`);\n",
  });
  try {
    const r = await p.op('find_unused_i18n_keys', { prefix: 'errors' });
    assert.ok('result' in r && r.result.ok);
    const view = r.result.data as View;
    assert.equal(view.degraded, true, 'dynamic call → degraded (global, not scoped away)');
    assert.ok(view.unused.length > 0, 'scoped to errors.*, still reports those keys');
    assert.ok(
      view.unused.every((u) => u.confidence === 'partial'),
      'scoping must NOT turn a globally-demoted key into a false certain dead',
    );
  } finally {
    await p.dispose();
  }
});
