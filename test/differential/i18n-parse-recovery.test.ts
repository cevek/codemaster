// Parse-failure degrade-and-continue (backlog item: `i18n_lookup` fatal on a malformed locale).
// A malformed locale file must NOT zero the whole i18n index — it contributes the keys of its
// WELL-FORMED PREFIX (every property before the first parse error), surfaced as `partial` with the
// parse failure noted, CONSISTENTLY across i18n_lookup / find_unused / find_missing (they share the
// parser). The §16 oracle is independent of the parser under test: for a recoverable malformation
// whose repair preserves key paths, the recovered set must equal a hand-flatten of the REPAIRED
// JSON (via JSON.parse, not parseLocaleKeys); the prefix-boundary cases are hand-built scenarios.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { project } from '../helpers/project.ts';

const TSCONFIG = '{"compilerOptions":{"strict":true}}';
const CONFIG =
  "import {defineConfig} from 'codemaster';\n" +
  "export default defineConfig({ i18n: { locales: ['locales/*.json'] } });\n";
const APP = "const t = (k: string) => k;\nexport const x = t('alpha');\n";

const data = (res: unknown): Record<string, unknown> =>
  (res as { result: { ok: boolean; data: Record<string, unknown> } }).result.data;
// Every recovered key, regardless of usage — i18n_lookup with no selector enumerates the index.
const lookupKeys = (d: Record<string, unknown>): string[] =>
  [...new Set(((d['defs'] as { key: string }[]) ?? []).map((x) => x.key))].sort();
const unused = (d: Record<string, unknown>): { key: string; confidence: string }[] =>
  (d['unused'] as { key: string; confidence: string }[]) ?? [];

// Independent oracle: flatten a (well-formed) JSON object the same way the plugin flattens, but
// over JSON.parse — never the parser under test.
function flatten(obj: Record<string, unknown>, prefix = ''): string[] {
  const out: string[] = [];
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix === '' ? k : `${prefix}.${k}`;
    if (v !== null && typeof v === 'object' && !Array.isArray(v))
      out.push(...flatten(v as Record<string, unknown>, key));
    else out.push(key);
  }
  return out;
}

test('trailing comma: recovers the full prefix (== repaired JSON), never zeroed', async () => {
  // The commonest malformation — and parseJsonText emits NO diagnostic for it, so the JSON.parse
  // position is the only boundary. Every key is well-formed; the repair removes only the comma.
  const malformed = '{ "alpha": "A", "beta": "B", }';
  const repaired = '{ "alpha": "A", "beta": "B" }';
  const oracle = flatten(JSON.parse(repaired) as Record<string, unknown>).sort();

  const p = await project({
    'tsconfig.json': TSCONFIG,
    'codemaster.config.ts': CONFIG,
    'locales/en.json': malformed,
    'src/app.ts': APP,
  });
  try {
    const lk = data(await p.op('i18n_lookup', {}));
    assert.deepEqual(lookupKeys(lk), oracle, 'recovered keys == repaired-JSON keys (not zeroed)');
    assert.ok(
      Array.isArray(lk['parseFailures']) && (lk['parseFailures'] as unknown[]).length === 1,
      'the parse failure is surfaced — recovery is honest, never silent',
    );

    // A direct lookup of a recovered-but-unused key still finds it (the item-B symptom: fatal).
    const beta = data(await p.op('i18n_lookup', { key: 'beta' }));
    assert.equal(
      (beta['defs'] as { key: string }[]).length,
      1,
      'beta is found despite the failure',
    );

    // find_unused sees the same keys, flagged partial (file is broken), degraded. `partials:'list'`
    // surfaces the demoted rows individually (the default collapses them to a count summary).
    const ud = data(await p.op('find_unused_i18n_keys', { partials: 'list' }));
    const betaDead = unused(ud).find((u) => u.key === 'beta');
    assert.ok(betaDead, 'beta (unused) surfaces as recovered dead, not lost to a zeroed index');
    assert.equal(betaDead?.confidence, 'partial', 'a recovered key is partial, never certain');
    assert.equal(ud['degraded'], true);

    // find_missing degrades honestly (the only locale is unreadable) — does not crash/zero.
    const md = data(await p.op('find_missing_i18n_keys', {}));
    assert.match(String(md['degradedReason']), /failed to parse|incomplete/);
  } finally {
    await p.dispose();
  }
});

test('post-error keys are DROPPED (no mis-path past the first error)', async () => {
  // `"bad"` lacks its colon → first error there. `post.q` sits AFTER the error: parseJsonText keeps
  // parsing and would re-emit it (and a garbage key from the value), but those are untrusted — they
  // must NOT appear. `good.a` (before the error) must.
  const p = await project({
    'tsconfig.json': TSCONFIG,
    'codemaster.config.ts': CONFIG,
    'locales/en.json': '{ "good": { "a": "1" }, "bad" "z": "2", "post": { "q": "9" } }',
    'src/app.ts': APP,
  });
  try {
    const keys = lookupKeys(data(await p.op('i18n_lookup', {})));
    assert.ok(keys.includes('good.a'), 'a key before the first error is recovered');
    assert.ok(!keys.includes('post.q'), 'a key after the first error is NOT recovered (mis-path)');
    assert.ok(!keys.includes('2'), 'no garbage key from the broken value past the error');
  } finally {
    await p.dispose();
  }
});

test('early brace mismatch: recovered keys stay partial (the mis-path safety net)', async () => {
  // A missing `}` is detected LATE, so `b` re-nests onto `a.b` (a path the author may not have meant)
  // even though its name precedes the error offset — the offset cut cannot catch this. The safety
  // contract: such a key is recovered ONLY as `partial` with the parse failure noted, never `certain`
  // — within the "broken file, verify yourself" envelope, not a hard `certain` lie.
  const p = await project({
    'tsconfig.json': TSCONFIG,
    'codemaster.config.ts': CONFIG,
    'locales/en.json': '{ "a": { "x": "1",\n  "b": "2"\n}',
    'src/app.ts': APP, // uses 'alpha' — none of these keys are used → all are dead candidates
  });
  try {
    const ud = data(await p.op('find_unused_i18n_keys', { partials: 'list' }));
    const recovered = unused(ud);
    assert.ok(recovered.length > 0, 'a malformed file still contributes its prefix keys');
    assert.ok(
      recovered.every((u) => u.confidence === 'partial'),
      'EVERY recovered key is partial — a possible mis-path is never asserted certain',
    );
    assert.equal(ud['degraded'], true, 'the broken file demotes the scan');
    assert.ok(
      Array.isArray(data(await p.op('i18n_lookup', {}))['parseFailures']),
      'the parse failure is surfaced',
    );
  } finally {
    await p.dispose();
  }
});

test('multi-locale: a broken locale recovers keys that feed missing-analysis of READABLE locales', async () => {
  // en is malformed but recovers `only_en`; de is well-formed and lacks it. de IS checkable, so the
  // recovered key drives a real "missing in de" verdict — recovery is not inert, and the broken
  // locale itself is never claimed certain-missing (it is excluded via parseFailures).
  const p = await project({
    'tsconfig.json': TSCONFIG,
    'codemaster.config.ts': CONFIG,
    'locales/en.json': '{ "only_en": "E", "shared": "S", }', // trailing comma → recoverable
    'locales/de.json': JSON.stringify({ shared: 'S' }),
    'src/app.ts': "const t = (k: string) => k;\nexport const x = t('only_en');\n",
  });
  try {
    const md = data(await p.op('find_missing_i18n_keys', {}));
    const miss = (md['missing'] as { key: string; missingLocales: string[] }[]) ?? [];
    const row = miss.find((m) => m.key === 'only_en');
    assert.ok(row, 'the recovered en key is seen by missing-analysis');
    assert.deepEqual(row?.missingLocales, ['de'], 'missing in de (checkable); en is not claimed');
    assert.match(String(md['degradedReason']), /failed to parse|incomplete/);
  } finally {
    await p.dispose();
  }
});
