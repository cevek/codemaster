// config-reload (§3.5 read-path, §9 lifecycle): a `codemaster.config.*` change is detected
// on request entry and APPLIED — the orchestrator evicts the warm engine on config drift so
// the next request lazily re-spawns with the fresh plugin set. The oracle is the i18n plugin
// gate (present iff `config.i18n` is set): enabling / adding-where-none / removing the section
// flips whether `find_unused_i18n_keys` is available, and the recorded evictions confirm the
// engine actually re-spawned (vs a stale baked plugin set). Invalid config must fail HONESTLY
// (the prior engine evicted, never served stale) and recover when fixed.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { project, type TestProject } from '../helpers/project.ts';

const TSCONFIG = '{"compilerOptions":{"strict":true}}';
const APP = "const t = (k: string) => k;\nexport const x = t('greeting');\n";
const I18N_CONFIG =
  "import {defineConfig} from 'codemaster';\n" +
  "export default defineConfig({ i18n: { locales: ['locales/*.json'] } });\n";
const BARE_CONFIG = "import {defineConfig} from 'codemaster';\nexport default defineConfig({});\n";

/** The i18n plugin is config-gated → `find_unused_i18n_keys` (requires ['ts','i18n']) reports
 *  `unavailable` when off and runs (ok) when on. A clean binary oracle for the active set. */
async function i18nActive(p: TestProject): Promise<boolean> {
  const r = await p.op('find_unused_i18n_keys', {});
  if ('error' in r) {
    assert.equal(r.error.kind, 'unavailable', `unexpected error: ${r.error.message}`);
    return false;
  }
  return true;
}

const baseFiles = {
  'tsconfig.json': TSCONFIG,
  'locales/en.json': JSON.stringify({ greeting: 'hi' }),
  'src/app.ts': APP,
};

test('config edit enabling i18n re-spawns the engine with the i18n plugin', async () => {
  const p = await project({ ...baseFiles, 'codemaster.config.ts': BARE_CONFIG });
  try {
    assert.equal(await i18nActive(p), false, 'i18n must be inactive before the edit');
    p.write('codemaster.config.ts', I18N_CONFIG);
    assert.equal(await i18nActive(p), true, 'editing the config to enable i18n must apply');
    assert.ok(
      p.evictions().some((l) => l.includes('config changed')),
      'the edit must have evicted the stale-config engine',
    );
  } finally {
    await p.dispose();
  }
});

test('adding a config where none existed enables its plugins', async () => {
  const p = await project(baseFiles); // no codemaster.config.* → pure defaults
  try {
    assert.equal(await i18nActive(p), false, 'defaults carry no i18n plugin');
    p.write('codemaster.config.ts', I18N_CONFIG);
    assert.equal(await i18nActive(p), true, 'a freshly-added config must be picked up');
  } finally {
    await p.dispose();
  }
});

test('removing the config falls back to defaults (drops the i18n plugin)', async () => {
  const p = await project({ ...baseFiles, 'codemaster.config.ts': I18N_CONFIG });
  try {
    assert.equal(await i18nActive(p), true, 'i18n active under the config');
    p.remove('codemaster.config.ts');
    assert.equal(await i18nActive(p), false, 'removing the config must drop config-gated plugins');
  } finally {
    await p.dispose();
  }
});

test('an unchanged config does NOT evict on a repeat request (no thrash)', async () => {
  const p = await project({ ...baseFiles, 'codemaster.config.ts': I18N_CONFIG });
  try {
    assert.equal(await i18nActive(p), true);
    assert.equal(await i18nActive(p), true); // second entry, config untouched
    assert.deepEqual(
      p.evictions().filter((l) => l.includes('config changed')),
      [],
      'an unchanged config must never trigger a config-change eviction',
    );
  } finally {
    await p.dispose();
  }
});

test('invalid config fails honestly (no stale serve) and recovers when fixed', async () => {
  const p = await project({ ...baseFiles, 'codemaster.config.ts': I18N_CONFIG });
  try {
    assert.equal(await i18nActive(p), true, 'good config first — a warm i18n engine exists');

    // Break it: a syntax error so the re-evaluation throws. The prior engine is evicted, so
    // the next request must NOT keep serving the stale-but-working config — it must say why.
    p.write('codemaster.config.ts', 'export default {{{ broken');
    await assert.rejects(
      () => p.op('find_unused_i18n_keys', {}),
      (err: Error) => {
        assert.match(err.message, /config/i, 'the failure must name the config, actionably');
        assert.match(err.message, /codemaster\.config\.ts/, 'and the offending file');
        return true;
      },
      'a broken config must surface an honest error, never a stale success',
    );

    // Fix it → the next request re-spawns cleanly (recovery via the per-request loadConfig retry).
    p.write('codemaster.config.ts', I18N_CONFIG);
    assert.equal(await i18nActive(p), true, 'fixing the config must recover without a restart');
  } finally {
    await p.dispose();
  }
});
