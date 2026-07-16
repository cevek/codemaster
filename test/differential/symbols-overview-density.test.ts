// t-757714 — the honesty gate for the `symbols_overview` output DENSITY polish (§12 house style, no
// info loss). Each claim is a discriminating behavioral pin: the terser/repacked output must carry the
// SAME facts as the verbose form (§3.4) and stay deterministic (§16 cold == warm). Never golden-only.
//   • duplicatesOnly config LEGEND — codes deterministic (config path-asc → A/B), every emitted code
//     resolves against the legend (0 info loss — each config label appears once in the legend).
//   • short group headers — the redundant `/tsconfig.json` is dropped but the dir is kept; a variant
//     basename + a root config are preserved (unique short→full map).
//   • note gating — flag-specific caveats appear ONLY under their flag; every always-on signal kept.
//   • group order — name-count DESC, path-asc tie-break, deterministic.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { project, type TestProject } from '../helpers/project.ts';
import type { JsonValue } from '../../src/core/json.ts';

interface GroupRow {
  config: string;
  names: string;
}
interface Data {
  configs?: string;
  note?: string;
  catalogue?: GroupRow[];
}

async function list(p: TestProject, args: JsonValue): Promise<Data> {
  const [res] = await p.request([{ name: 'symbols_overview', args }]);
  assert.ok(res !== undefined && 'result' in res && res.result.ok, 'symbols_overview ok');
  return res.result.data as unknown as Data;
}
function namesOf(g: GroupRow | undefined): string[] {
  if (g === undefined || g.names.length === 0) return [];
  return g.names.split(', ');
}
/** Parse an `A=cfgA, B=cfgB` legend line into a code→config map. */
function legend(d: Data): Map<string, string> {
  const out = new Map<string, string>();
  for (const part of (d.configs ?? '').split(', ')) {
    const i = part.indexOf('=');
    if (i > 0) out.set(part.slice(0, i), part.slice(i + 1));
  }
  return out;
}

// ── duplicatesOnly legend: deterministic A/B by config path-asc; every SHOWN code resolves ──────────
const DUP_MULTI: Record<string, string> = {
  'tsconfig.json': '{"compilerOptions":{"strict":true},"include":["z"]}',
  'apps/a/tsconfig.json': '{"compilerOptions":{"strict":true},"include":["src"]}',
  'apps/a/src/x.ts': 'export const Shared = 1;\nexport const Only = 2;',
  'z/x.ts': 'export const Shared = 3;', // a 2nd real decl of Shared, in the root config
};

test('duplicatesOnly legend: codes deterministic (config path-asc → A/B) and always resolvable', async () => {
  const p = await project(DUP_MULTI);
  try {
    const d = await list(p, { duplicatesOnly: true, limit: 1000 });
    const tokens = namesOf((d.catalogue ?? [])[0]);
    const leg = legend(d);
    // Two configs span the collision: `apps/a` (short) and `tsconfig.json` (root). Path-asc → A, B.
    assert.equal(leg.get('A'), 'apps/a', 'first legend code (path-asc) → apps/a');
    assert.equal(leg.get('B'), 'tsconfig.json', 'second → tsconfig.json');
    // Shared collides across BOTH → its token references both codes.
    assert.deepEqual(tokens, ['Shared ×2 (A|B)'], 'Shared ×2 references both legend codes');
    // §3.4: EVERY code in the (post-cap) body resolves against the legend (never a dangling code).
    for (const t of tokens) {
      const codes = /\(([^)]*)\)/.exec(t)?.[1]?.split('|') ?? [];
      for (const c of codes) assert.ok(leg.has(c), `code ${c} present in the legend`);
    }
  } finally {
    await p.dispose();
  }
});

// ── short group headers: strip the redundant `/tsconfig.json`; keep variant basenames + root ────────
const NESTED: Record<string, string> = {
  'tsconfig.json': '{"compilerOptions":{"strict":true},"include":["src"]}', // root — no dir to strip
  'apps/web/tsconfig.json': '{"compilerOptions":{"strict":true},"include":["src"]}',
  'apps/web/tsconfig.build.json': '{"compilerOptions":{"strict":true},"include":["gen"]}', // variant
  'src/root.ts': 'export const RootThing = 1;',
  'apps/web/src/web.ts': 'export const WebThing = 1;',
  'apps/web/gen/g.ts': 'export const GenThing = 1;',
};

test('group headers drop the redundant /tsconfig.json but keep the dir (and variant basenames + root)', async () => {
  const p = await project(NESTED);
  try {
    const labels = new Set((await list(p, { limit: 1000 })).catalogue?.map((g) => g.config) ?? []);
    // apps/web/tsconfig.json → `apps/web` (dir kept, standard basename dropped — no info loss).
    assert.ok(labels.has('apps/web'), 'nested standard config shortened to its dir (apps/web)');
    assert.ok(!labels.has('apps/web/tsconfig.json'), 'the long form is gone');
    // A variant basename carries signal → kept in full (never collapsed to `apps/web`, which would
    // collide with the standard config's short label — the two stay distinct).
    assert.ok(labels.has('apps/web/tsconfig.build.json'), 'variant basename kept in full');
    // Root tsconfig.json has no dir to strip → passes through unchanged.
    assert.ok(labels.has('tsconfig.json'), 'root tsconfig.json passes through');
  } finally {
    await p.dispose();
  }
});

// ── note gating: flag-specific caveats appear ONLY under their flag (no wall of prose otherwise) ────
const SHAPES: Record<string, string> = {
  'tsconfig.json': '{"compilerOptions":{"strict":true},"include":["src"]}',
  'src/a.ts': 'export const Ca = 1;\nexport type Ta = "x";',
};

test('note gates flag-specific caveats: histogram only under summary, dup-def only under duplicatesOnly', async () => {
  const p = await project(SHAPES);
  try {
    const plain = String((await list(p, { limit: 1000 })).note);
    assert.doesNotMatch(plain, /Histogram:/, 'default note carries NO histogram caveat');
    assert.doesNotMatch(plain, /duplicatesOnly:/, 'default note carries NO duplicatesOnly caveat');
    // Every always-on honesty signal is still present in the terse default note.
    assert.match(plain, /not type-verified/, 'syntactic-not-verified signal kept');
    assert.match(plain, /outside-root tsconfig include is NOT covered/, 'outside-root scope kept');
    assert.match(plain, /search_symbol \/ find_definition/, 'pick→search steer kept');

    const summary = String((await list(p, { summary: true, limit: 1000 })).note);
    assert.match(summary, /Histogram:/, 'summary note ADDS the multi-bucket histogram caveat');
    assert.doesNotMatch(summary, /duplicatesOnly:/, 'summary note still has NO dup caveat');

    const dup = String((await list(p, { duplicatesOnly: true, limit: 1000 })).note);
    assert.match(
      dup,
      /duplicatesOnly:/,
      'duplicatesOnly note ADDS the collision-definition caveat',
    );
    assert.doesNotMatch(dup, /Histogram:/, 'duplicatesOnly note has NO histogram caveat');
  } finally {
    await p.dispose();
  }
});

// ── group order: name-count DESC, path-asc tie-break, deterministic (cold == warm) ──────────────────
const SIZED: Record<string, string> = {
  'tsconfig.json': '{"compilerOptions":{"strict":true},"include":["big"]}',
  'apps/mid/tsconfig.json': '{"compilerOptions":{"strict":true},"include":["src"]}',
  'apps/small/tsconfig.json': '{"compilerOptions":{"strict":true},"include":["src"]}',
  'big/x.ts': 'export const B1=1;\nexport const B2=2;\nexport const B3=3;\nexport const B4=4;',
  'apps/mid/src/x.ts': 'export const M1=1;\nexport const M2=2;',
  'apps/small/src/x.ts': 'export const S1=1;',
};

test('groups are ordered by name-count DESC with a deterministic path-asc tie-break', async () => {
  const p = await project(SIZED);
  try {
    const first = await list(p, { limit: 1000 });
    const order = (first.catalogue ?? []).map((g) => g.config);
    // big(4) → mid(2) → small(1): count-desc leads with the real surface.
    assert.deepEqual(
      order,
      ['tsconfig.json', 'apps/mid', 'apps/small'],
      'largest config first, smallest last',
    );
    // Determinism (cold == warm): a second identical call returns byte-identical rows in the same order.
    const second = await list(p, { limit: 1000 });
    assert.deepEqual(second.catalogue, first.catalogue, 'two calls agree (deterministic)');
  } finally {
    await p.dispose();
  }
});
