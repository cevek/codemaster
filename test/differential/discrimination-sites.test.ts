// `discrimination_sites` (t-304222) — CORE oracle tests. The oracle is hand-curated (§16, never
// grep/golden-only): the enumerated positives — a `switch` on a bare-variable discriminant, a
// `switch` on a PROPERTY-ACCESS scrutinee (`spec.type.kind`, which `find_usages` on the type NAME
// structurally misses), and an `if/else-if` chain — must appear; the three decoys (an unrelated
// union's `.kind`, a NON-discriminant property `.value` of a T-typed object, and a STRUCTURAL
// supertype `{ kind: string }`) must NOT (the identity + discriminant gates are the precision
// guarantee). Covers/missing vs T's literal domain is asserted, and the motivating gap vs
// find_usages is pinned directly.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { project, assertSpansValid } from '../helpers/project.ts';

type Site = {
  kind: 'switch' | 'if-chain';
  span: { file: string; line: number; col: number };
  scrutinee: string;
  discriminant: string;
  confidence: string;
  note?: string;
  covers: string[];
  missing: string[];
  hasDefault: boolean;
  encloser: { name: string; id: string; kind: string };
};
type DView = {
  target: {
    name: string;
    kind: string;
    span: { file: string };
    discriminants: { name: string; domain: string[] }[];
  };
  sites: Site[];
  scannedStatements: number;
  notes?: string[];
};

const TYPES = `export type FieldType =
  | { kind: 'text'; value: string }
  | { kind: 'num'; value: number }
  | { kind: 'bool'; value: boolean };

export interface FieldSpec {
  type: FieldType;
  label: string;
}

type Shape = { kind: 'circle' | 'square'; area: number };
export type { Shape };
`;

const RENDER = `import type { FieldType, FieldSpec, Shape } from './types';

// (1) switch on a bare variable of type FieldType
export function renderField(f: FieldType): string {
  switch (f.kind) {
    case 'text': return f.value;
    case 'num': return String(f.value);
    case 'bool': return String(f.value);
  }
}

// (2) switch on a PROPERTY-ACCESS scrutinee (spec.type.kind), spec: FieldSpec — find_usages misses this
export function renderSpec(spec: FieldSpec): string {
  switch (spec.type.kind) {
    case 'text': return 'T';
    case 'num': return 'N';
    case 'bool': return 'B';
  }
}

// (3) if/else-if chain discriminating on FieldType, missing 'bool' but with a trailing else
export function widthOf(f: FieldType): number {
  if (f.kind === 'text') return 10;
  else if (f.kind === 'num') return 5;
  else return 1;
}

// (4) switch missing 'bool' with NO default — the exhaustiveness gap
export function partialSwitch(f: FieldType): string {
  switch (f.kind) {
    case 'text': return 'T';
    case 'num': return 'N';
  }
  return '';
}

// DECOY (a): switch on an UNRELATED union's .kind
export function decoyUnrelated(s: Shape): string {
  switch (s.kind) {
    case 'circle': return 'C';
    case 'square': return 'S';
  }
}

// DECOY (b): switch on a NON-discriminant property of a T-typed object (typeof — rejected syntactically)
export function decoyNonDiscriminant(f: FieldType): string {
  switch (typeof f.value) {
    case 'string': return 's';
    default: return 'x';
  }
}

// DECOY (b'): DIRECT property-access switch on a NON-discriminant field (.value is string|number|boolean,
// not a literal/unit) — reaches resolveDomain and must be rejected by the DISCRIMINANT gate specifically
export function decoyNonDiscriminantDirect(f: FieldType): string {
  switch (f.value) {
    case 'x': return '1';
    default: return '0';
  }
}

// DECOY (c): switch on a STRUCTURAL supertype { kind: string } — NOT identity FieldType
export function decoyStructural(x: { kind: string }): string {
  switch (x.kind) {
    case 'text': return 'T';
    default: return 'D';
  }
}
`;

/** Every `line` reported for `src/render.ts` anywhere in a result payload (spans nest under
 *  varying keys across find_usages' rollup shapes, so walk generically rather than assume a shape). */
function collectRenderLines(data: unknown): number[] {
  const lines: number[] = [];
  const walk = (v: unknown): void => {
    if (Array.isArray(v)) {
      v.forEach(walk);
    } else if (v !== null && typeof v === 'object') {
      const o = v as Record<string, unknown>;
      if (o['file'] === 'src/render.ts' && typeof o['line'] === 'number') lines.push(o['line']);
      Object.values(o).forEach(walk);
    }
  };
  walk(data);
  return lines;
}

function proj() {
  return project({
    'tsconfig.json': '{"compilerOptions":{"strict":true}}',
    'src/types.ts': TYPES,
    'src/render.ts': RENDER,
  });
}

test('finds switch (bare + property-access) and if-chain discriminations, excludes all decoys', async () => {
  const p = await proj();
  try {
    const r = await p.op('discrimination_sites', { name: 'FieldType' });
    assert.ok('result' in r && r.result.ok, JSON.stringify(r));
    const view = r.result.data as DView;

    // Target: the union + its discriminant domain (proof of WHAT T is).
    assert.equal(view.target.name, 'FieldType');
    assert.equal(view.target.kind, 'type');
    const kind = view.target.discriminants.find((d) => d.name === 'kind');
    assert.ok(kind !== undefined, 'kind is identified as the discriminant');
    assert.deepEqual([...kind.domain].sort(), ["'bool'", "'num'", "'text'"]);
    // ONLY kind is a discriminant — `value` (string|number|boolean, non-uniform primitive) is not.
    assert.equal(view.target.discriminants.length, 1, 'exactly one discriminant (kind), not value');

    const by = new Map(view.sites.map((s) => [s.encloser.name, s]));

    // Positive 1 — bare-variable switch, all cases covered, certain.
    const rf = by.get('renderField');
    assert.ok(rf !== undefined, 'renderField switch(f.kind) is found');
    assert.equal(rf.kind, 'switch');
    assert.equal(rf.confidence, 'certain');
    assert.deepEqual(rf.missing, []);

    // Positive 2 — PROPERTY-ACCESS scrutinee spec.type.kind (the find_usages blind spot).
    const rs = by.get('renderSpec');
    assert.ok(
      rs !== undefined,
      'renderSpec switch(spec.type.kind) is found — the property-access case',
    );
    assert.equal(rs.scrutinee, 'spec.type.kind');
    assert.equal(rs.confidence, 'certain');

    // Positive 3 — if/else-if chain, missing 'bool', partial (heuristic), has trailing else.
    const w = by.get('widthOf');
    assert.ok(w !== undefined, 'widthOf if-chain is found');
    assert.equal(w.kind, 'if-chain');
    assert.equal(w.confidence, 'partial');
    assert.deepEqual(w.missing, ["'bool'"]);
    assert.equal(w.hasDefault, true);

    // Positive 4 — the exhaustiveness gap: missing 'bool', NO default.
    const ps = by.get('partialSwitch');
    assert.ok(ps !== undefined, 'partialSwitch is found');
    assert.deepEqual(ps.missing, ["'bool'"]);
    assert.equal(ps.hasDefault, false);

    // Decoys — each excluded by a distinct gate (unrelated union · typeof · non-discriminant prop
    // reaching resolveDomain directly · structural supertype).
    for (const decoy of [
      'decoyUnrelated',
      'decoyNonDiscriminant',
      'decoyNonDiscriminantDirect',
      'decoyStructural',
    ]) {
      assert.ok(!by.has(decoy), `${decoy} must NOT be reported`);
    }
    assert.equal(view.sites.length, 4, 'exactly the four T-discriminating sites');

    // Proof-span validity (§16 inv.1): every switch/if keyword span equals the live source.
    assertSpansValid(p.root, r);
  } finally {
    await p.dispose();
  }
});

test('covers the gap find_usages structurally misses (the property-access switch line)', async () => {
  const p = await proj();
  try {
    const usages = await p.op('find_usages', { name: 'FieldType' });
    assert.ok('result' in usages && usages.result.ok, JSON.stringify(usages));
    // renderSpec's body is lines 14–20 (its switch on spec.type.kind is line 15). The identifier
    // FieldType never appears in renderSpec, so NO find_usages reference lands in that range — the
    // structural blind spot this op fills. Collect every render.ts line find_usages reports.
    const usageLines = collectRenderLines(usages.result.data);
    assert.ok(
      !usageLines.some((n) => n >= 14 && n <= 20),
      `find_usages reaches no reference inside renderSpec (14–20); got lines ${usageLines.join(',')}`,
    );

    const disc = await p.op('discrimination_sites', { name: 'FieldType' });
    assert.ok('result' in disc && disc.result.ok);
    const view = disc.result.data as DView;
    assert.ok(
      view.sites.some((s) => s.encloser.name === 'renderSpec'),
      'discrimination_sites DOES find the property-access switch find_usages missed',
    );
  } finally {
    await p.dispose();
  }
});

test('bare literal-union: switch(x) on the value discriminates, and the encloser id chains', async () => {
  const p = await project({
    'tsconfig.json': '{"compilerOptions":{"strict":true}}',
    'src/dir.ts': `export type Dir = 'north' | 'south' | 'east' | 'west';
export function turn(d: Dir): number {
  switch (d) {
    case 'north': return 0;
    case 'south': return 180;
  }
  return -1;
}
`,
  });
  try {
    const r = await p.op('discrimination_sites', { name: 'Dir' });
    assert.ok('result' in r && r.result.ok, JSON.stringify(r));
    const view = r.result.data as DView;
    assert.equal(view.sites.length, 1, 'the bare switch(d) is found');
    const site = view.sites[0];
    assert.ok(site !== undefined);
    assert.equal(
      site.discriminant,
      '(value)',
      'a bare value switch reports (value) as the discriminant',
    );
    assert.deepEqual([...site.missing].sort(), ["'east'", "'west'"]);

    // The encloser SymbolId chains into another op (§6).
    const def = await p.op('find_definition', { symbolId: site.encloser.id });
    assert.ok('result' in def && def.result.ok, JSON.stringify(def));
    const defs = (def.result.data as { definitions?: { name: string }[] }).definitions ?? [];
    assert.ok(
      defs.some((d) => d.name === 'turn'),
      'the encloser id resolves to its decl',
    );
  } finally {
    await p.dispose();
  }
});

test('a uniform boolean field is NOT a discriminant (the boolean-intrinsic-is-a-union trap)', async () => {
  // `boolean` is internally `true | false`; a uniform `on: boolean` across constituents must NOT
  // masquerade as a {true,false} discriminant — else every `switch(x.on)` floods as certain-on-T.
  const p = await project({
    'tsconfig.json': '{"compilerOptions":{"strict":true}}',
    'src/t.ts': `export type Toggle = { kind: 'a'; on: boolean } | { kind: 'b'; on: boolean };
export function f(x: Toggle): number {
  switch (x.on) {
    case true: return 1;
    case false: return 0;
  }
}
`,
  });
  try {
    const r = await p.op('discrimination_sites', { name: 'Toggle' });
    assert.ok('result' in r && r.result.ok, JSON.stringify(r));
    const view = r.result.data as DView;
    assert.ok(
      !view.target.discriminants.some((d) => d.name === 'on'),
      'the uniform boolean field `on` is NOT a discriminant',
    );
    assert.deepEqual(
      view.target.discriminants.map((d) => d.name),
      ['kind'],
      'only kind discriminates',
    );
    assert.ok(
      !view.sites.some((s) => s.scrutinee === 'x.on'),
      'switch(x.on) is not reported as discriminating on Toggle',
    );
  } finally {
    await p.dispose();
  }
});

test('a non-union target answers honestly with a note, not a crash or false sites', async () => {
  const p = await project({
    'tsconfig.json': '{"compilerOptions":{"strict":true}}',
    'src/i.ts': `export interface Plain { a: number; b: string }
export function f(p: Plain): void {
  switch (p.a) { case 1: break; }
}
`,
  });
  try {
    const r = await p.op('discrimination_sites', { name: 'Plain' });
    assert.ok('result' in r && r.result.ok, JSON.stringify(r));
    const view = r.result.data as DView;
    assert.equal(view.sites.length, 0, 'no discriminant on a non-union → no sites');
    assert.ok(
      (view.notes ?? []).some((n) => /not a union/.test(n)),
      'the reason is stated',
    );
  } finally {
    await p.dispose();
  }
});
