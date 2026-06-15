// find_missing honesty around parse failures (§3.6). The §16 oracle is a hand-built scenario:
// a key present in the only READABLE locale yields an empty `missing`, but an unreadable locale
// makes that emptiness UNPROVABLE — the op must flag the analysis incomplete (degradedReason),
// never let `missing: []` read as "fully translated".

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { project } from '../helpers/project.ts';

const TSCONFIG = '{"compilerOptions":{"strict":true}}';
const CONFIG =
  "import {defineConfig} from 'codemaster';\n" +
  "export default defineConfig({ i18n: { locales: ['locales/*.json'] } });\n";

test('find_missing: a parse-failed locale degrades the analysis (empty missing ≠ fully translated)', async () => {
  const p = await project({
    'tsconfig.json': TSCONFIG,
    'codemaster.config.ts': CONFIG,
    'locales/en.json': JSON.stringify({ a: '1' }),
    'locales/de.json': '{ "a": "1", }', // malformed JSON → unreadable
    'src/app.ts': "const t = (k: string) => k;\nexport const x = t('a');\n",
  });
  try {
    const r = await p.op('find_missing_i18n_keys', {});
    assert.ok('result' in r && r.result.ok);
    const data = r.result.data as { missing: unknown[]; degradedReason?: string };
    // 'a' is present in the only readable locale → nothing PROVABLY missing...
    assert.equal(data.missing.length, 0);
    // ...but de.json is unreadable, so we cannot see whether 'a' is missing there — say so.
    assert.match(
      String(data.degradedReason),
      /failed to parse|incomplete/,
      'an empty result over a partially-unreadable locale set must not read as complete',
    );
  } finally {
    await p.dispose();
  }
});
