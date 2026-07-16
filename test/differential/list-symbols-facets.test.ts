// t-960572 — the honesty gate for the `list_symbols` orientation facets (query / summary /
// duplicatesOnly / kind[] / subgroupByKind). Each claim against an independent oracle or a
// discriminating behavioral pin (never grep, never golden-only); each fails BEFORE the facet exists
// (the strict schema rejects the new arg). The central invariant — NEVER warms the LS (OOM-safe) — is
// re-asserted across every facet: that is the whole point of the no-program engine.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { project, type TestProject } from '../helpers/project.ts';
import type { JsonValue } from '../../src/core/json.ts';

interface GroupRow {
  config: string;
  shown: number;
  total: number;
  names: string;
  alsoIn?: string[];
  more?: string;
}
interface Data {
  names: number;
  groups: number;
  histogram?: string;
  byConfig?: string;
  catalogue?: GroupRow[];
}

async function list(p: TestProject, args: JsonValue): Promise<Data> {
  const [res] = await p.request([{ name: 'list_symbols', args }]);
  assert.ok(res !== undefined && 'result' in res, 'dispatched');
  assert.ok(
    res.result.ok,
    `list_symbols ok (${JSON.stringify((res.result as { failure?: unknown }).failure)})`,
  );
  return res.result.data as unknown as Data;
}
function namesOf(g: GroupRow | undefined): string[] {
  if (g === undefined || g.names.length === 0) return [];
  return g.names.split(', ');
}
function allNames(d: Data): Set<string> {
  const out = new Set<string>();
  for (const g of d.catalogue ?? []) for (const n of namesOf(g)) out.add(n);
  return out;
}
/** Parse a `const 3 · interface 2` histogram string into a kind→count map. */
function histogram(d: Data): Map<string, number> {
  const out = new Map<string, number>();
  for (const part of (d.histogram ?? '').split(' · ')) {
    const m = /^(.+) (\d+)$/.exec(part);
    if (m !== null) out.set(m[1] as string, Number(m[2]));
  }
  return out;
}
async function tsIsCold(p: TestProject): Promise<boolean> {
  const status = await p.orchestrator.status(p.root, p.root);
  return status.workspace?.plugins.find((x) => x.id === 'ts')?.fingerprint === 'cold';
}

// ── query: navto fuzzy name filter, applied BEFORE the per-group cap ────────────────────────────
const CLINIC: Record<string, string> = {
  'tsconfig.json': '{"compilerOptions":{"strict":true},"include":["src"]}',
  'src/a.ts': [
    'export interface ClinicRow { id: string }',
    'export interface ClinicRowHeader { title: string }',
    'export const ClinicList = 1;',
    'export interface Patient { name: string }',
    'export const Appointment = 2;',
  ].join('\n'),
};

test('query narrows to the matching family (before the cap) and drops non-matches', async () => {
  const p = await project(CLINIC);
  try {
    const full = allNames(await list(p, { limit: 1000 }));
    assert.ok(full.has('Patient') && full.has('ClinicRow'), 'no-query superset has both families');

    const got = allNames(await list(p, { query: 'Clinic', limit: 1000 }));
    assert.ok(
      got.has('ClinicRow') && got.has('ClinicRowHeader') && got.has('ClinicList'),
      'Clinic* kept',
    );
    assert.ok(!got.has('Patient'), 'non-matching Patient dropped');
    assert.ok(!got.has('Appointment'), 'non-matching Appointment dropped');
    assert.ok(
      [...got].every((n) => full.has(n)),
      'query result ⊆ full catalogue (never invents)',
    );

    // BEFORE the cap: with cap=1 the Clinic family is 3 → the query filtered first, then capped to 1.
    const capped = await list(p, { query: 'Clinic', limit: 1 });
    const g = (capped.catalogue ?? [])[0];
    assert.ok(
      g !== undefined && g.total === 3 && g.shown === 1,
      'query applied before cap (total=3 of the family, shown=1)',
    );
    assert.ok(await tsIsCold(p), 'query never warms the LS');
  } finally {
    await p.dispose();
  }
});

// ── summary: multi-bucket histogram + per-config totals, counts of the FULL (uncapped) set ──────
const SHAPES: Record<string, string> = {
  'tsconfig.json': '{"compilerOptions":{"strict":true},"include":["src"]}',
  'src/a.ts': [
    'export interface Ia { a: string }',
    'export interface Ib { b: string }',
    'export interface Ic { c: string }', // 3 interfaces
    'export const Ca = 1;',
    'export const Cb = 2;', // 2 consts (+ Merge below → 3 in the const bucket)
    'export type Ta = "x";', // 1 type (+ Merge → 2 in the type bucket)
    'export const Merge = 3;',
    'export type Merge = string;', // a value+type MERGE — one NAME, two kinds
  ].join('\n'),
};

test('summary histogram: fixture-known per-kind counts, multi-bucket, NOT capped', async () => {
  const p = await project(SHAPES);
  try {
    // Tiny cap: proves the counts are of the FULL set, not the shown body.
    const d = await list(p, { summaryOnly: true, limit: 1 });
    const h = histogram(d);
    assert.equal(h.get('interface'), 3, 'interface count = full set (3), not capped');
    assert.equal(h.get('const'), 3, 'const bucket = Ca,Cb,Merge');
    assert.equal(
      h.get('type'),
      2,
      'type bucket = Ta,Merge — the merge counts in BOTH const and type',
    );

    // distinct names: Ia,Ib,Ic,Ca,Cb,Ta,Merge = 7.
    assert.equal(d.names, 7, 'name-total is the DISTINCT count (Merge once)');
    const bucketSum = [...h.values()].reduce((a, b) => a + b, 0);
    assert.ok(
      bucketSum > d.names,
      'multi-bucket: buckets sum ABOVE the name-total (the merge double-counts)',
    );

    // summaryOnly omits the names body; the counts still stand.
    assert.equal(d.catalogue, undefined, 'summaryOnly omits the catalogue body');
    assert.match(String(d.byConfig), /tsconfig\.json 7/, 'per-config total is the full 7');
    assert.ok(await tsIsCold(p), 'summary never warms the LS');
  } finally {
    await p.dispose();
  }
});

// ── duplicatesOnly: a REAL-decl-in-≥2-files collision; a barrel re-export is NOT one ────────────
const DUP: Record<string, string> = {
  'tsconfig.json': '{"compilerOptions":{"strict":true},"include":["src"]}',
  'src/a.ts': 'export const Dup = 1;\nexport const Uniq = 2;',
  'src/b.ts': 'export const Dup = 3;', // a SECOND real declaration of Dup
  'src/barrel.ts': "export { Dup, Uniq } from './a';", // re-exports — NOT real decls
};

test('duplicatesOnly flags a genuine cross-file collision, never a barrel re-export', async () => {
  const p = await project(DUP);
  try {
    const d = await list(p, { duplicatesOnly: true, limit: 1000 });
    const tokens = namesOf((d.catalogue ?? [])[0]);
    // Dup has 2 real decls (a.ts, b.ts) → ×2. The barrel re-export adds a 3rd MENTION but no real decl.
    assert.deepEqual(
      tokens,
      ['Dup ×2 (tsconfig.json)'],
      'exactly Dup ×2 — barrel re-export not counted as a 3rd site',
    );
    assert.ok(
      !tokens.some((t) => t.startsWith('Uniq')),
      'Uniq (one real decl + a re-export) is NOT a collision',
    );
    assert.ok(await tsIsCold(p), 'duplicatesOnly never warms the LS');
  } finally {
    await p.dispose();
  }
});

// ── kind[]: an array matches ANY listed kind ────────────────────────────────────────────────────
const KINDS: Record<string, string> = {
  'tsconfig.json': '{"compilerOptions":{"strict":true},"include":["src"]}',
  'src/a.ts': [
    'export interface If { a: string }',
    'export type Tf = "x";',
    'export const Cf = 1;',
    'export function Fn() { return 1; }',
  ].join('\n'),
};

test('kind accepts an array — matches ANY listed kind', async () => {
  const p = await project(KINDS);
  try {
    const got = allNames(await list(p, { kind: ['interface', 'type'], limit: 1000 }));
    assert.deepEqual([...got].sort(), ['If', 'Tf'], 'interface + type only');
    assert.ok(!got.has('Cf') && !got.has('Fn'), 'const/function excluded');
    // A scalar kind still works (union backward-compat).
    const one = allNames(await list(p, { kind: 'const', limit: 1000 }));
    assert.deepEqual([...one], ['Cf'], 'scalar kind still filters');
    assert.ok(await tsIsCold(p), 'kind[] never warms the LS');
  } finally {
    await p.dispose();
  }
});

// ── subgroupByKind: partition each config into kind subsections; default flat is byte-stable ────
const SUB: Record<string, string> = {
  'tsconfig.json': '{"compilerOptions":{"strict":true},"include":["src"]}',
  'src/a.ts': [
    'export interface If { a: string }',
    'export const Cf = 1;',
    'export const Merge = 2;',
    'export type Merge = string;', // multi-kind → must appear in BOTH the const and type subsections
  ].join('\n'),
};

test('subgroupByKind partitions a config into kind subsections; multi-kind name in each; default is flat', async () => {
  const p = await project(SUB);
  try {
    const flatData = await list(p, { limit: 1000 });
    assert.ok(
      (flatData.catalogue ?? []).every((g) => !g.config.includes(' › ')),
      'default: no kind subsections (flat, byte-stable shape)',
    );

    const d = await list(p, { subgroupByKind: true, limit: 1000 });
    const byLabel = new Map((d.catalogue ?? []).map((g) => [g.config, namesOf(g)]));
    assert.ok(byLabel.has('tsconfig.json › interface'), 'an interface subsection exists');
    assert.deepEqual(byLabel.get('tsconfig.json › const'), ['Cf', 'Merge'], 'const subsection');
    assert.deepEqual(byLabel.get('tsconfig.json › type'), ['Merge'], 'type subsection');
    assert.ok(
      (byLabel.get('tsconfig.json › const') ?? []).includes('Merge') &&
        (byLabel.get('tsconfig.json › type') ?? []).includes('Merge'),
      'multi-kind Merge appears in BOTH its kind subsections',
    );
    assert.ok(await tsIsCold(p), 'subgroupByKind never warms the LS');
  } finally {
    await p.dispose();
  }
});

// ── shared-config annotation survives the config›kind layout ────────────────────────────────────
const SHARED: Record<string, string> = {
  'tsconfig.json': '{"compilerOptions":{"strict":true},"include":["src"]}',
  'tsconfig.test.json': '{"compilerOptions":{"strict":true},"include":["src","test"]}',
  'src/shared.ts': 'export const S = 1;\nexport interface Si { a: string }',
  'test/only.ts': 'export const T = 2;',
};

test('subgroupByKind preserves the (shared: also in …) annotation', async () => {
  const p = await project(SHARED);
  try {
    const d = await list(p, { subgroupByKind: true, limit: 1000 });
    const base = (d.catalogue ?? []).filter((g) => g.config.startsWith('tsconfig.json › '));
    assert.ok(base.length > 0, 'base config has kind subsections');
    // The shared flag lands on the FIRST subsection of the config (not lost, not repeated on all).
    const flagged = base.filter(
      (g) => g.alsoIn !== undefined && g.alsoIn.includes('tsconfig.test.json'),
    );
    assert.equal(
      flagged.length,
      1,
      'shared annotation on exactly one subsection of the shared config',
    );
  } finally {
    await p.dispose();
  }
});
