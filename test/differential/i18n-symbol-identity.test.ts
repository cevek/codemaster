// Task I — i18n match by SYMBOL IDENTITY (spec-i18n-symbol-identity). With `i18n.module` (and a
// `hook`) configured, a `t('…')` call counts iff its callee binding resolves to a function FROM
// that module — not merely a same-named `t`. This closes the by-name model's two residuals:
//
//   • FALSE POSITIVE — a `t` from a NON-i18n module (`import { t } from './telemetry'`) no longer
//     fabricates a usage / a find_missing row, and no longer keeps a locale key alive.
//   • FALSE NEGATIVE — a key reached only through a renamed destructure of the real hook
//     (`const { t: x } = useTranslation()`) or a renamed-namespace import (`import * as foo from
//     '@/lib/i18n'; foo.t()`) IS now counted.
//
// Oracle = a hand-curated fixture enumerating every shape, with the i18n module exporting a bare
// `t` (namespace/alias paths) AND a `useTranslation` hook (destructure path) in one repo. Dynamic
// keys still demote to `partial` (§18); provenance is asserted per row (F-c).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { project, assertSpansValid, type TestProject } from '../helpers/project.ts';

const TSCONFIG = JSON.stringify({
  compilerOptions: {
    strict: true,
    jsx: 'react-jsx',
    baseUrl: '.',
    paths: { '@/*': ['src/*'] },
    module: 'esnext',
    moduleResolution: 'bundler',
  },
});

// Identity config: the module owns the i18n function; `useTranslation` returns it.
const CONFIG =
  `import { defineConfig } from 'codemaster';\n` +
  `export default defineConfig({ i18n: { locales: ['locales/*.json'], module: '@/lib/i18n', hook: 'useTranslation' } });\n`;

const EN = JSON.stringify(
  {
    wr: 'written', // used via the bare module export        t('wr')
    al: 'alias', // used via a renamed import               tr('al')
    ns: 'namespace', // used via a renamed namespace import  foo.t('ns')
    de: 'destructure', // used via a renamed hook destructure  x('de')
    ghost: 'ghost', // referenced ONLY by telemetry t()       → must read UNUSED (FP closed)
    dead: 'dead', // referenced by nothing                    → UNUSED
  },
  null,
  2,
);

// The real i18n module: a bare `t` export + a `useTranslation` hook returning `{ t }`.
const LIB =
  `export function t(key: string): string {\n  return key;\n}\n` +
  `export function useTranslation(): { t: (key: string) => string } {\n  return { t };\n}\n`;

// A DIFFERENT module that also exports a `t` — the false-positive source.
const TELEMETRY = `export function t(event: string): string {\n  return event;\n}\n`;

const APP =
  `import { t } from '@/lib/i18n';\n` + // bare module export
  `import { useTranslation } from '@/lib/i18n';\n` + // the hook
  `import * as foo from '@/lib/i18n';\n` + // namespace import (renamed)
  `import { t as tr } from '@/lib/i18n';\n` + // aliased named import
  `import { t as telT } from './telemetry.ts';\n` + // SAME-named t from a NON-i18n module
  `export const a = t('wr');\n` + // → provenance written
  `export const b = foo.t('ns');\n` + // → provenance namespace
  `export const c = tr('al');\n` + // → provenance alias
  `export const g = telT('ghost');\n` + // telemetry → must NOT count (key stays unused)
  `export const h = telT('telemetry.only');\n` + // telemetry, key absent → must NOT be 'missing'
  `export function Comp(): string {\n` +
  `  const { t: x } = useTranslation();\n` + // renamed hook destructure
  `  return x('de');\n` + // → provenance destructure
  `}\n`;

function identityProject(extraApp = ''): Promise<TestProject> {
  return project({
    'codemaster.config.ts': CONFIG,
    'tsconfig.json': TSCONFIG,
    'locales/en.json': EN,
    'src/lib/i18n.ts': LIB,
    'src/telemetry.ts': TELEMETRY,
    'src/app.ts': APP + extraApp,
  });
}

type Unused = { key: string; confidence: string };
type Usage = { key: string; span: { file: string; line: number }; provenance: string };

test('identity: only telemetry-only + dead keys are unused (FP closed, FN closed, certain)', async () => {
  const p = await identityProject();
  try {
    const res = await p.op('find_unused_i18n_keys', {});
    const data = (res as { result: { data: Record<string, unknown> } }).result.data;
    const unused = (data['unused'] as Unused[]) ?? [];
    const keys = unused.map((u) => u.key).sort();

    // ghost (telemetry kept it 'alive' under by-name — now correctly DEAD: FP closed) + dead.
    // wr/al/ns/de are all RESOLVED as used through identity (FN closed for the renamed
    // destructure + renamed namespace), so they are NOT over-reported.
    assert.deepEqual(
      keys,
      ['dead', 'ghost'],
      'telemetry t() does not keep ghost alive; every identity usage of wr/al/ns/de is recognised',
    );
    // No dynamic call, no parse failure, module resolved → certain.
    assert.equal(data['degraded'], false, 'no dynamic / parse / unresolved → certain');
    for (const u of unused) assert.equal(u.confidence, 'certain', 'certain, not falsely demoted');
  } finally {
    await p.dispose();
  }
});

test('identity: a telemetry key absent from locale is NOT fabricated as missing', async () => {
  const p = await identityProject();
  try {
    const res = await p.op('find_missing_i18n_keys', {});
    const data = (res as { result: { data: Record<string, unknown> } }).result.data;
    const missing = (data['missing'] as { key: string }[]) ?? [];
    assert.equal(
      missing.find((m) => m.key === 'telemetry.only'),
      undefined,
      'telT("telemetry.only") is not an i18n usage — no fabricated missing row',
    );
    // Every real i18n usage (wr/al/ns/de) exists in en → nothing certain-missing.
    assert.equal(missing.length, 0, 'all identity-resolved keys exist in en');
  } finally {
    await p.dispose();
  }
});

test('identity: provenance is correct per usage row (written | alias | namespace | destructure)', async () => {
  const p = await identityProject();
  try {
    const expected: Record<string, string> = {
      wr: 'written',
      al: 'alias',
      ns: 'namespace',
      de: 'destructure',
    };
    for (const [key, provenance] of Object.entries(expected)) {
      const res = await p.op('i18n_lookup', { key });
      const data = (res as { result: { data: Record<string, unknown> } }).result.data;
      const usages = (data['usages'] as Usage[]) ?? [];
      assert.equal(usages.length, 1, `${key} resolves to exactly one identity usage`);
      assert.equal(usages[0]?.provenance, provenance, `${key} provenance = ${provenance}`);
      assertSpansValid(p.root, res as never);
    }
    // The telemetry key must have NO i18n usage.
    const tel = await p.op('i18n_lookup', { key: 'ghost' });
    const td = (tel as { result: { data: Record<string, unknown> } }).result.data;
    assert.equal(
      (td['usages'] as unknown[] | undefined)?.length ?? 0,
      0,
      'ghost has no i18n usage',
    );
  } finally {
    await p.dispose();
  }
});

test('identity: a dynamic key with a scoped head leaves unrelated keys certain (§18, backlog I-a)', async () => {
  // Add a dynamic call of the REAL identity-bound `t`; it must be detected as dynamic, but its
  // static head `x.` can only resolve under `x.*` — so the unrelated dead keys (dead, ghost)
  // stay PROVABLY dead instead of being buried in partial.
  const p = await identityProject(`export const dyn = t(\`x.\${a}\`);\n`);
  try {
    const res = await p.op('find_unused_i18n_keys', {});
    const data = (res as { result: { data: Record<string, unknown> } }).result.data;
    assert.equal(data['degraded'], true, 'a dynamic identity-bound t(`…`) is detected');
    assert.equal(data['globalDemote'], false, 'a scoped head (x.) does not degrade the whole scan');
    assert.match(String(data['degradedReason']), /dynamic/i);
    for (const u of (data['unused'] as Unused[]) ?? [])
      assert.equal(u.confidence, 'certain', 'unrelated dead keys stay certain under a scoped head');
  } finally {
    await p.dispose();
  }
});

test('identity: a module that does NOT resolve demotes to partial (never a silent all-dead)', async () => {
  // Configure a module that no file imports / that does not exist → no binding can match, so
  // every key looks dead. Honesty (§3.6): demote, never assert certain-dead.
  const p = await project({
    'codemaster.config.ts':
      `import { defineConfig } from 'codemaster';\n` +
      `export default defineConfig({ i18n: { locales: ['locales/*.json'], module: '@/lib/does-not-exist' } });\n`,
    'tsconfig.json': TSCONFIG,
    'locales/en.json': JSON.stringify({ live: 'L' }),
    'src/lib/i18n.ts': LIB,
    'src/app.ts': `import { t } from '@/lib/i18n';\nexport const a = t('live');\n`,
  });
  try {
    // Global demotion (nothing matched) → the default render collapses the all-partial set to a
    // summary; partials:'list' surfaces the rows so the per-key partial confidence is verifiable.
    const res = await p.op('find_unused_i18n_keys', { partials: 'list' });
    const data = (res as { result: { data: Record<string, unknown> } }).result.data;
    assert.equal(data['degraded'], true, 'an unresolved i18n module demotes the verdict');
    assert.equal(data['globalDemote'], true, 'an unresolved module is global, not scoped');
    assert.match(String(data['degradedReason']), /did not resolve/i);
    const rows = (data['unused'] as Unused[]) ?? [];
    assert.ok(rows.length > 0, 'the keys are listed (as partial) under partials:list');
    for (const u of rows)
      assert.equal(u.confidence, 'partial', 'no certain-dead when nothing could be matched');
  } finally {
    await p.dispose();
  }
});

test('cold == warm: the memoized identity scan equals a fresh scan after a reindex', async () => {
  // F-a memo is keyed on freshness + spec; a reindex must invalidate it so warm == cold.
  const sortKeys = (data: Record<string, unknown>): string[] =>
    ((data['unused'] as Unused[]) ?? []).map((u) => u.key).sort();

  // Warm: baseline op (pins freshness), ADD a usage of `ghost`, re-query — the memo must
  // invalidate (projectVersion bumps) and reflect that ghost is now used.
  const warmP = await identityProject();
  let warm: string[];
  try {
    await warmP.op('find_unused_i18n_keys', {});
    warmP.write('src/more.ts', `import { t } from '@/lib/i18n';\nexport const z = t('ghost');\n`);
    const op2 = await warmP.op('find_unused_i18n_keys', {});
    assert.ok('result' in op2 && op2.result.ok);
    // op#2 MUST reindex incrementally — otherwise it is a disguised cold boot and never exercises
    // memo invalidation across an incremental reindex (the convention in cold-equals-warm.test.ts).
    assert.ok(
      (op2.result.freshness?.reindexed ?? 0) >= 1,
      'the warm path must reindex incrementally at op#2 — otherwise the memo invalidation is untested',
    );
    const data = (op2 as { result: { data: Record<string, unknown> } }).result.data;
    warm = sortKeys(data);
    assert.deepEqual(warm, ['dead'], 'after the add, ghost is used — memo invalidated, not stale');
  } finally {
    await warmP.dispose();
  }

  // Cold: boot over the identical final tree, query once.
  const coldP = await project({
    'codemaster.config.ts': CONFIG,
    'tsconfig.json': TSCONFIG,
    'locales/en.json': EN,
    'src/lib/i18n.ts': LIB,
    'src/telemetry.ts': TELEMETRY,
    'src/app.ts': APP,
    'src/more.ts': `import { t } from '@/lib/i18n';\nexport const z = t('ghost');\n`,
  });
  try {
    const res = await coldP.op('find_unused_i18n_keys', {});
    const cold = sortKeys((res as { result: { data: Record<string, unknown> } }).result.data);
    assert.deepEqual(warm, cold, 'a memoized warm scan matches a cold rebuild over the final tree');
  } finally {
    await coldP.dispose();
  }
});

test('identity: non-destructured hook return + literal element access are USED, not certain-dead', async () => {
  // The §3 lie a reviewer caught: a key reached only via `const o = useTranslation(); o.t(k)` or
  // `ns['t'](k)` was reported confidence=certain UNUSED (a live key asserted dead). Both shapes
  // resolve to a base PROVEN to bind the module, so matching the literal leaf fabricates nothing.
  const p = await project({
    'codemaster.config.ts': CONFIG,
    'tsconfig.json': TSCONFIG,
    'locales/en.json': JSON.stringify({ ret: 'R', elem: 'E', dead: 'D' }),
    'src/lib/i18n.ts': LIB,
    'src/app.ts':
      `import { useTranslation } from '@/lib/i18n';\n` +
      `import * as ns from '@/lib/i18n';\n` +
      `export function A(): string {\n  const o = useTranslation();\n  return o.t('ret');\n}\n` + // non-destructured return
      `export const e = ns['t']('elem');\n`, // literal element access on a namespace base
  });
  try {
    const res = await p.op('find_unused_i18n_keys', {});
    const data = (res as { result: { data: Record<string, unknown> } }).result.data;
    const keys = ((data['unused'] as Unused[]) ?? []).map((u) => u.key).sort();
    assert.deepEqual(keys, ['dead'], 'ret (o.t) and elem (ns["t"]) are recognised as used');
    assert.equal(data['degraded'], false, 'no false demotion');
  } finally {
    await p.dispose();
  }
});

test('identity: a default-import i18n object IS matched (the common `import i18n` shape)', async () => {
  // `import i18n from '@/lib/i18n'; i18n.t('k')` is the common i18next shape. NOT matching it would
  // mark a LIVE key `certain`-dead — a §3 lie. The theoretical fabrication (default export lacks
  // `.t`) needs non-compiling code, since `i18n.t()` only typechecks when `.t` exists.
  const p = await project({
    'codemaster.config.ts': CONFIG,
    'tsconfig.json': TSCONFIG,
    'locales/en.json': JSON.stringify({ viaDefault: 'V', dead: 'D' }),
    'src/lib/i18n.ts': LIB + `export default { t: (key: string): string => key };\n`,
    'src/app.ts': `import i18n from '@/lib/i18n';\nexport const a = i18n.t('viaDefault');\n`,
  });
  try {
    const unusedRes = await p.op('find_unused_i18n_keys', {});
    const ud = (unusedRes as { result: { data: Record<string, unknown> } }).result.data;
    const keys = ((ud['unused'] as Unused[]) ?? []).map((u) => u.key).sort();
    assert.deepEqual(
      keys,
      ['dead'],
      'default-import i18n.t() is matched — viaDefault is used, only dead is unused',
    );
    assert.equal(ud['degraded'], false, 'no false demotion');
  } finally {
    await p.dispose();
  }
});

test('identity: a dotted config base is NOT attributed to a default import (no over-merge)', async () => {
  // Regression: a default import's local name is arbitrary, so a dotted config base `ns.t` (a NAMED
  // export) must NOT be merged onto it — else `x.t('k')` fabricates an `ns.t` usage and hides a
  // dead key. The legit named-dotted path (`import { ns }; ns.t()`) must still resolve.
  const p = await project({
    'codemaster.config.ts':
      `import { defineConfig } from 'codemaster';\n` +
      `export default defineConfig({ i18n: { locales: ['locales/*.json'], functions: ['ns.t'], module: '@/lib/i18n' } });\n`,
    'tsconfig.json': TSCONFIG,
    'locales/en.json': JSON.stringify({ realKey: 'R', phantomKey: 'P' }),
    'src/lib/i18n.ts':
      `export const ns = { t: (key: string): string => key };\n` +
      `export default { t: (key: string): string => key };\n`,
    'src/app.ts':
      `import { ns } from '@/lib/i18n';\n` +
      `import x from '@/lib/i18n';\n` +
      `export const a = ns.t('realKey');\n` + // named dotted base → matched
      `export const b = x.t('phantomKey');\n`, // default import → NOT an ns.t usage
  });
  try {
    const res = await p.op('find_unused_i18n_keys', {});
    const data = (res as { result: { data: Record<string, unknown> } }).result.data;
    const keys = ((data['unused'] as Unused[]) ?? []).map((u) => u.key).sort();
    assert.deepEqual(
      keys,
      ['phantomKey'],
      'ns.t(realKey) matched; x.t(phantomKey) NOT attributed to ns.t — phantomKey stays unused',
    );
  } finally {
    await p.dispose();
  }
});

test('identity: i18n_lookup flags usagesIncomplete when the module does not resolve', async () => {
  // A reviewer §3.6 catch: empty `usages` under an unresolved module must NOT read as "used
  // nowhere" — the lookup carries an explicit incompleteness flag.
  const p = await project({
    'codemaster.config.ts':
      `import { defineConfig } from 'codemaster';\n` +
      `export default defineConfig({ i18n: { locales: ['locales/*.json'], module: '@/lib/nope' } });\n`,
    'tsconfig.json': TSCONFIG,
    'locales/en.json': JSON.stringify({ live: 'L' }),
    'src/lib/i18n.ts': LIB,
    'src/app.ts': `import { t } from '@/lib/i18n';\nexport const a = t('live');\n`,
  });
  try {
    const res = await p.op('i18n_lookup', { key: 'live' });
    const data = (res as { result: { data: Record<string, unknown> } }).result.data;
    assert.ok(
      typeof data['usagesIncomplete'] === 'string',
      'an unresolved module must flag usage incompleteness, not present usages:[] as authoritative',
    );
    assert.match(String(data['usagesIncomplete']), /did not resolve/i);
  } finally {
    await p.dispose();
  }
});
