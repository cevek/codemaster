// Scoped demote verdict + blocking-call attribution (t-949045, §3.4/§3.6). Two claims are under
// test, and they pull in opposite directions — which is what makes the arms discriminate:
//
//  (1) a SCOPED question must not be decided by an UNSCOPED fact: an answer whose every reported
//      row is provable is not `degraded` because a dynamic call demoted some OTHER namespace; and
//      the remedy hint must never propose the state the call is already in (both reporters passed
//      `prefix=` and were told to "narrow with prefix").
//  (2) the demote must still reach every key it CAN produce — the counter-arms below query INSIDE
//      the demoted namespace and assert every reported row is `partial`. Over-narrowing here means
//      a live locale string reported dead, so arm (2) matters more than arm (1).
//
// The §16 oracle is the fixture's construction, never another codemaster answer: the fixture
// DECLARES the dynamic call's static bound and the line it sits on, so "which keys can this call
// produce" and "where is the blocker" are known independently of the code under test.

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
// The bound the oracle knows: the ONLY dynamic call is confined to `errors.codes.` and sits on
// line 4, col 20 (`t(` starts at col 18 → the argument span starts at 20).
const SCOPED_CALL =
  'const t = (k: string) => k;\n' +
  "const x = 'e1';\n" +
  "export const a = t('ui.ok');\n" +
  'export const b = t(`errors.codes.${x}`);\n';

type Row = { key: string; confidence: string };
type Site = { span: { file: string; line: number; col: number } };
type View = {
  unused: Row[];
  degraded: boolean;
  globalDemote: boolean;
  degradedReason?: string;
  blocking?: { count: number; sites: Site[]; more?: number };
  partial?: { count: number; demoted?: 'global' | string[]; hint?: string };
};

function okView(r: OpResult): View {
  assert.ok('result' in r && r.result.ok, JSON.stringify(r));
  return r.result.data as View;
}
const loc = (s: Site): string => `${s.span.file}:${s.span.line}:${s.span.col}`;

test('scoped demote: a prefix outside the demoted namespace is NOT degraded (and its rows stay certain)', async () => {
  const p = await project({
    'tsconfig.json': TSCONFIG,
    'codemaster.config.ts': CONFIG,
    'locales/en.json': LOCALE,
    'src/use.ts': SCOPED_CALL,
  });
  try {
    // ARM 1 — the fix. `ui.*` is disjoint from the call's `errors.codes.` bound, so nothing in
    // this answer is unprovable: no degraded flag, no reason about a namespace nobody asked about,
    // and no blocker (there is no call this answer rests on).
    const ui = okView(await p.op('find_unused_i18n_keys', { prefix: 'ui' }));
    assert.deepEqual(
      ui.unused.map((u) => u.key),
      ['ui.cancel'],
      'ui.ok is used, ui.cancel dead',
    );
    assert.ok(
      ui.unused.every((u) => u.confidence === 'certain'),
      'a key the dynamic call provably cannot produce is certain',
    );
    assert.equal(ui.degraded, false, 'a scoped question is not decided by an out-of-scope call');
    assert.equal(ui.degradedReason, undefined, 'no reason about errors.codes.* — it was not asked');
    assert.equal(ui.blocking, undefined, 'no call blocks an answer that is fully provable');

    // ARM 2 (the one that matters) — query INSIDE the demoted namespace. Every reported row must
    // still be partial; an over-narrowed demote would surface these as certain-dead, i.e. propose
    // deleting live strings.
    const inside = okView(
      await p.op('find_unused_i18n_keys', { prefix: 'errors.codes', partials: 'list' }),
    );
    assert.deepEqual(
      inside.unused.map((u) => [u.key, u.confidence]).sort(),
      [
        ['errors.codes.e1', 'partial'],
        ['errors.codes.e2', 'partial'],
      ],
      'every key the call CAN produce stays unprovable',
    );
    assert.equal(inside.degraded, true);

    // ARM 2b — a BROADER prefix keeps both halves in one answer: the demoted namespace partial,
    // its sibling certain. The verdict is degraded because a REPORTED row is partial.
    const broad = okView(
      await p.op('find_unused_i18n_keys', { prefix: 'errors', partials: 'list' }),
    );
    assert.deepEqual(
      broad.unused.map((u) => [u.key, u.confidence]).sort(),
      [
        ['errors.codes.e1', 'partial'],
        ['errors.codes.e2', 'partial'],
        ['errors.fatal', 'certain'],
      ],
      'per-key confidence is the whole-scan fact — scoping never upgrades it',
    );
    assert.equal(broad.degraded, true);
  } finally {
    await p.dispose();
  }
});

test('blocking call: named with file:line:col, and the hint never proposes the state the caller is in', async () => {
  const p = await project({
    'tsconfig.json': TSCONFIG,
    'codemaster.config.ts': CONFIG,
    'locales/en.json': LOCALE,
    'src/use.ts': SCOPED_CALL,
  });
  try {
    // Already narrowed INTO the demoted namespace: narrowing further cannot lift it (every
    // sub-namespace of a demoted head is demoted too), so the hint must say that — and must NOT
    // propose `prefix=`, which is exactly what the caller already did.
    const inside = okView(await p.op('find_unused_i18n_keys', { prefix: 'errors.codes' }));
    assert.equal(inside.blocking?.count, 1);
    assert.deepEqual(
      inside.blocking?.sites.map(loc),
      ['src/use.ts:4:20'],
      'the blocker is the fixture-declared call site',
    );
    const hint = inside.partial?.hint ?? '';
    assert.match(hint, /does not lift/, 'says plainly that narrowing cannot help here');
    assert.doesNotMatch(hint, /narrow with prefix/, 'never re-proposes the applied remedy');
    assert.match(hint, /src\/use\.ts:4:20/, 'the hint carries the blocker location');

    // Not yet narrowed → narrowing IS the real remedy (a prefix outside the demoted head returns
    // certain results), so the hint may propose it.
    const wide = okView(await p.op('find_unused_i18n_keys', {}));
    assert.match(
      wide.partial?.hint ?? '',
      /prefix=/,
      'an un-narrowed call is told narrowing works',
    );
  } finally {
    await p.dispose();
  }
});

test('blocking call: a headless t(x) blocks every key — named, capped deterministically, hint honest', async () => {
  // Three headless calls across two files (the shape that floods a real repo): unprovable by any
  // text analysis, so the demote is global and the only honest help is naming the sites.
  const p = await project({
    'tsconfig.json': TSCONFIG,
    'codemaster.config.ts': CONFIG,
    'locales/en.json': LOCALE,
    'src/a.ts':
      "import {t} from './t.ts';\n" +
      "const rows = [{labelKey: 'ui.ok'}];\n" +
      'export const a = rows.map((r) => t(r.labelKey));\n',
    'src/b.ts':
      "import {t} from './t.ts';\n" +
      'export const b = (k: string) => t(k);\n' +
      "export const c = t(String('ui.cancel'));\n",
    'src/t.ts': 'export const t = (k: string) => k;\n',
  });
  try {
    const v = okView(await p.op('find_unused_i18n_keys', { prefix: 'ui', partials: 'list' }));
    assert.equal(v.globalDemote, true, 'a headless call bounds nothing → every key unprovable');
    assert.ok(
      v.unused.every((u) => u.confidence === 'partial'),
      'no key is reported certain-dead while an unbounded call exists',
    );
    // Attribution: all three sites reach the reported keys; the display cap shows 3 in
    // file:line:col order and states the remainder inline (never a silent cut).
    assert.equal(v.blocking?.count, 3);
    const sites = v.blocking?.sites.map(loc) ?? [];
    assert.deepEqual(
      sites,
      // Columns counted by hand off the fixture source (1-based, at the ARGUMENT's first char).
      ['src/a.ts:3:36', 'src/b.ts:2:35', 'src/b.ts:3:20'],
      'sorted by file:line:col — a deterministic set under the cap',
    );
    assert.equal(v.blocking?.more, undefined, 'three sites fit the cap');

    const hint = okView(await p.op('find_unused_i18n_keys', { prefix: 'ui' })).partial?.hint ?? '';
    assert.match(hint, /does not lift/);
    assert.doesNotMatch(hint, /narrow with prefix/, 'the caller already narrowed');
    assert.match(hint, /src\/a\.ts:3:36/, 'the first blocker is named');
    assert.match(hint, /\+2 more/, 'the rest are counted, not dropped');
  } finally {
    await p.dispose();
  }
});

test('scoping never hides a cause that HIDES keys: an unreadable locale degrades an empty answer', async () => {
  // The boundary of the scoping. A parse failure does not demote keys — it makes the KEY SET
  // incomplete (a dead key could live only in the unreadable file), so an empty/clean-looking
  // answer is exactly the case that must stay flagged. Scoping `degraded` to the reported rows
  // must not swallow it, or "0 unused" reads as a proven-complete result over a file we never read.
  const p = await project({
    'tsconfig.json': TSCONFIG,
    'codemaster.config.ts': CONFIG,
    'locales/en.json': '{ "ui": { "ok": "OK" }, }', // trailing comma → recovered + recorded failure
    'src/use.ts': "const t = (k: string) => k;\nexport const a = t('ui.ok');\n",
  });
  try {
    const v = okView(await p.op('find_unused_i18n_keys', { prefix: 'ui' }));
    assert.deepEqual(v.unused, [], 'the only recovered key is used → nothing reported');
    assert.equal(v.degraded, true, 'an unreadable locale keeps even an EMPTY answer incomplete');
    assert.match(v.degradedReason ?? '', /failed to parse/);
    assert.equal(v.blocking, undefined, 'the cause is not a call — no call is blamed for it');
  } finally {
    await p.dispose();
  }
});

test('cold == warm: the blocker set and the scoped verdict survive an incremental edit', async () => {
  const initial = {
    'tsconfig.json': TSCONFIG,
    'codemaster.config.ts': CONFIG,
    'locales/en.json': LOCALE,
    'src/use.ts': SCOPED_CALL,
  };
  // Add a SECOND dynamic call in another file — the blocker list must re-sort identically in both.
  const added = 'const t = (k: string) => k;\nexport const z = t(`common.${String(1)}`);\n';
  const facts = (r: OpResult): string => {
    const v = okView(r);
    return JSON.stringify({
      degraded: v.degraded,
      reason: v.degradedReason ?? null,
      sites: v.blocking?.sites.map(loc) ?? [],
      rows: v.unused.map((u) => [u.key, u.confidence]).sort(),
    });
  };

  const warmP = await project(initial);
  let warm: string;
  try {
    await warmP.op('find_unused_i18n_keys', { partials: 'list' });
    warmP.write('src/added.ts', added);
    const r = await warmP.op('find_unused_i18n_keys', { partials: 'list' });
    assert.ok('result' in r && r.result.ok);
    warm = facts(r);
  } finally {
    await warmP.dispose();
  }

  const coldP = await project({ ...initial, 'src/added.ts': added });
  let cold: string;
  try {
    cold = facts(await coldP.op('find_unused_i18n_keys', { partials: 'list' }));
  } finally {
    await coldP.dispose();
  }

  assert.equal(warm, cold, 'an incrementally-patched scan must match a cold rebuild');
  assert.match(warm, /src\/added\.ts/, 'the newly-added dynamic call is among the blockers');
});
