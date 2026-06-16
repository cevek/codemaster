// Task F — i18n alias-aware usage resolution (spec-i18n-alias-aware). The blind spot was:
// usage matching was by call name AS WRITTEN, so an `import { t as tr }` then `tr('k')` was
// MISSED — `find_unused_*` over-reported and `i18n_lookup` under-reported. The fix resolves
// the callee through its IMPORT via the TS checker: a named-import alias resolves to the
// configured simple name `t`, and an aliased-base member access resolves to the configured
// dotted name `i18n.t`.
//
// HONESTY BOUNDARY (§3): a match must be strong enough to ASSERT (find_missing/i18n_lookup
// report positive facts). So resolution is confined to USER-NAMED bindings — a bare `t` does
// NOT match an arbitrary `<import>.t()` member access, and a destructure rename of a non-i18n
// value is not resolved. The last two tests pin THOSE two non-matches (the reviewers' fabrication
// repros) so they can never come back. NOTE the scope: they do NOT pin the named-import-alias
// by-name residual (`import { t as tr } from './telemetry'; tr('k')` DOES match by resolved name
// — config names the function, not the module; accepted, see docs/plan.md F-b). Oracle = a
// hand-curated fixture, every shape enumerated.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { project, assertSpansValid, type TestProject } from '../helpers/project.ts';

const TSCONFIG = '{"compilerOptions":{"strict":true,"jsx":"react-jsx"}}';
// `t` (simple → identifier alias) + `i18n.t` (dotted → member access, base resolved).
const CONFIG =
  `import { defineConfig } from 'codemaster';\n` +
  `export default defineConfig({ i18n: { locales: ['locales/*.json'], functions: ['t', 'i18n.t'] } });\n`;

const EN = JSON.stringify(
  {
    common: { save: 'Save' }, // used via aliased import     `tr('common.save')`
    ns: { key: 'NS' }, // used via namespace member    `i18n.t('ns.key')`
    aliasns: { key: 'A' }, // used via aliased-base member `i.t('aliasns.key')`
    plain: { key: 'P' }, // used via the bare name       `t('plain.key')`
    unused: { dead: 'nobody' }, // referenced by nothing
  },
  null,
  2,
);

// The i18n module: a `t` export + a namespace-shaped `i18n` object with a `.t` method.
const LIB =
  `export function t(key: string): string {\n  return key;\n}\n` +
  `export const i18n = { t: (key: string): string => key };\n`;

// Every usage shape the resolver must recognise:
const APP =
  `import { t as tr } from './i18n.ts';\n` + // aliased named import
  `import * as i18n from './i18n.ts';\n` + // namespace import (member base)
  `import { i18n as i, t } from './i18n.ts';\n` + // aliased-base import + plain
  `export const a = tr('common.save');\n` + // alias            → usage of t
  `export const b = i18n.t('ns.key');\n` + // namespace member → usage of i18n.t
  `export const f = i.t('aliasns.key');\n` + // aliased base     → usage of i18n.t
  `export const e = t('plain.key');\n` + // bare name        → usage of t
  'export const d = tr(`x.${a}`);\n'; // dynamic alias    → still unresolvable

function aliasProject(): Promise<TestProject> {
  return project({
    'codemaster.config.ts': CONFIG,
    'tsconfig.json': TSCONFIG,
    'locales/en.json': EN,
    'src/i18n.ts': LIB,
    'src/app.ts': APP,
  });
}

type Unused = { key: string; confidence: string };
type Usage = { key: string; span: { file: string; line: number } };

test('alias + namespace + aliased-base usages are NOT reported unused', async () => {
  const p = await aliasProject();
  try {
    const res = await p.op('find_unused_i18n_keys', {});
    const data = (res as { result: { ok: boolean; data: Record<string, unknown> } }).result.data;
    const unused = (data['unused'] as Unused[]) ?? [];
    const keys = unused.map((u) => u.key).sort();

    // ONLY the genuinely-dead key survives — every alias/namespace/aliased-base/bare usage was
    // resolved, so its key is NOT over-reported as unused.
    assert.deepEqual(
      keys,
      ['unused.dead'],
      'common.save (alias), ns.key (namespace), aliasns.key (aliased base), plain.key (bare) all recognised as used',
    );

    // The dynamic `tr(`x.${a}`)` still demotes EVERY claim to partial — the alias work resolves
    // the FUNCTION, never the key (§18 honesty preserved).
    assert.equal(data['degraded'], true, 'a dynamic aliased call is still detected as dynamic');
    for (const u of unused) assert.equal(u.confidence, 'partial', 'dynamic demotes to partial');
    assert.match(String(data['degradedReason']), /dynamic/i);
  } finally {
    await p.dispose();
  }
});

test('i18n_lookup finds the aliased usage site (proof span into the call)', async () => {
  const p = await aliasProject();
  try {
    const res = await p.op('i18n_lookup', { key: 'common.save' });
    const data = (res as { result: { ok: boolean; data: Record<string, unknown> } }).result.data;
    const usages = (data['usages'] as Usage[]) ?? [];
    assert.equal(usages.length, 1, "the aliased `tr('common.save')` call is a usage of t");
    assert.ok(usages[0]?.span.file.endsWith('app.ts'), 'usage span points at the call site');
    assertSpansValid(p.root, res as never);
  } finally {
    await p.dispose();
  }
});

test('namespace + aliased-base member access found via lookup (i18n.t dotted config)', async () => {
  const p = await aliasProject();
  try {
    for (const key of ['ns.key', 'aliasns.key']) {
      const res = await p.op('i18n_lookup', { key });
      const data = (res as { result: { ok: boolean; data: Record<string, unknown> } }).result.data;
      const usages = (data['usages'] as Usage[]) ?? [];
      assert.equal(usages.length, 1, `${key} resolves to a member-access usage of i18n.t`);
      assertSpansValid(p.root, res as never);
    }
  } finally {
    await p.dispose();
  }
});

test('dynamic aliased key is listed unresolvable, never guessed', async () => {
  const p = await aliasProject();
  try {
    const res = await p.op('find_missing_i18n_keys', {});
    const data = (res as { result: { ok: boolean; data: Record<string, unknown> } }).result.data;
    const dyn = (data['dynamicUsages'] as unknown[]) ?? [];
    assert.equal(
      dyn.length,
      1,
      'the one dynamic `tr(`x.${a}`)` is unresolvable, listed separately',
    );
    // All static keys exist in the single locale → nothing certain-missing.
    const missing = (data['missing'] as unknown[]) ?? [];
    assert.equal(missing.length, 0, 'every resolved static key exists in en');
  } finally {
    await p.dispose();
  }
});

test('HONESTY: an unrelated namespace `tel.t()` is NOT counted as the i18n t (no fabrication)', async () => {
  // Reviewer repro: a bare `t` config must NEVER match an arbitrary `<import>.t()` — that would
  // fabricate a "missing i18n key" / a usage for a telemetry call. Member access matches ONLY a
  // configured dotted name, and `tel` is not a configured base.
  const p = await project({
    'codemaster.config.ts':
      `import { defineConfig } from 'codemaster';\n` +
      `export default defineConfig({ i18n: { locales: ['locales/*.json'], functions: ['t'] } });\n`,
    'tsconfig.json': TSCONFIG,
    'locales/en.json': JSON.stringify({ real: { key: 'R' } }),
    'src/telemetry.ts': `export function t(event: string): string {\n  return event;\n}\n`,
    'src/app.ts':
      `import * as tel from './telemetry.ts';\n` +
      `export const a = tel.t('analytics.pageview');\n`,
  });
  try {
    const missingRes = await p.op('find_missing_i18n_keys', {});
    const md = (missingRes as { result: { data: Record<string, unknown> } }).result.data;
    const missing = (md['missing'] as { key: string }[]) ?? [];
    assert.equal(
      missing.find((m) => m.key === 'analytics.pageview'),
      undefined,
      'a telemetry tel.t() must NOT fabricate a missing i18n key',
    );
    const lookupRes = await p.op('i18n_lookup', { key: 'analytics.pageview' });
    const ld = (lookupRes as { result: { data: Record<string, unknown> } }).result.data;
    assert.equal((ld['usages'] as unknown[] | undefined)?.length ?? 0, 0, 'no fabricated usage');
  } finally {
    await p.dispose();
  }
});

test('HONESTY: a destructure rename of a non-i18n value is NOT resolved (no fabrication)', async () => {
  // Reviewer repro: `const { t: x } = makeLogger(); x('k')` must NOT count — only user-named
  // bindings (written name / named-import alias / dotted base) are resolved, never an arbitrary
  // destructure of any value with a `.t` property.
  const p = await project({
    'codemaster.config.ts':
      `import { defineConfig } from 'codemaster';\n` +
      `export default defineConfig({ i18n: { locales: ['locales/*.json'], functions: ['t'] } });\n`,
    'tsconfig.json': TSCONFIG,
    'locales/en.json': JSON.stringify({ dead: { key: 'D' } }),
    'src/log.ts': `export function makeLogger(): { t: (label: string) => void } {\n  return { t: () => {} };\n}\n`,
    'src/app.ts':
      `import { makeLogger } from './log.ts';\n` +
      `const { t: x } = makeLogger();\n` +
      `export function run(): void {\n  x('dead.key');\n}\n`,
  });
  try {
    const res = await p.op('find_unused_i18n_keys', {});
    const data = (res as { result: { data: Record<string, unknown> } }).result.data;
    const unused = (data['unused'] as Unused[]).map((u) => u.key).sort();
    assert.deepEqual(
      unused,
      ['dead.key'],
      'the logger destructure x() is not the i18n t — dead.key stays correctly unused',
    );
    assert.equal(
      data['degraded'],
      false,
      'no dynamic/parse-failure → certain (not falsely demoted)',
    );
  } finally {
    await p.dispose();
  }
});
