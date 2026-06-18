// `find_usages mergeDeclarations` (DX feedback): in this repo nearly every plugin-API method name
// is a TsPluginApi interface-decl + a TsProjectHost-decl + an impl, so `find_usages {name}` almost
// always fails on the 3-way ambiguity. `mergeDeclarations:true` unions the reference sets of ALL
// same-named declarations into one answer while keeping PER-SITE provenance (`usages[].decls`), so
// two UNRELATED same-named symbols are never silently conflated (§3.3).
//
// Oracle: a cold, whole-program LS — `getReferencesAtPosition` at EACH declaration, unioned by
// file:line (a DIFFERENT LS than the warm daemon's, §16). The merge must equal exactly that union.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { project, type TestProject } from '../helpers/project.ts';
import { coldReferenceSites } from '../helpers/cold-ls.ts';
import type { OpResult } from '../../src/ops/contracts.ts';

type Usage = { span: { file: string; line: number; col?: number }; role: string; decls?: number[] };
type Decl = { name: string; kind: string; span: { file: string } };

// Three UNRELATED interfaces each declaring `tick` — the triplet pattern. find_usages {name:'tick'}
// is ambiguous (3 distinct declarations); merge unions their disjoint reference sets.
const FILES = {
  'tsconfig.json': '{"compilerOptions":{"strict":true}}',
  'src/a.ts': 'export interface A { tick(): number }\n',
  'src/b.ts': 'export interface B { tick(): number }\n',
  'src/c.ts': 'export interface C { tick(): number }\n',
  'src/use.ts':
    "import type { A } from './a';\n" +
    "import type { B } from './b';\n" +
    "import type { C } from './c';\n" +
    'export const ua = (x: A): number => x.tick();\n' +
    'export const ub = (y: B): number => y.tick();\n' +
    'export const uc = (z: C): number => z.tick();\n',
};

function okResult(r: OpResult): { usages?: Usage[]; mergedDeclarations?: Decl[] } {
  assert.ok('result' in r && r.result.ok, JSON.stringify(r));
  return r.result.data as { usages?: Usage[]; mergedDeclarations?: Decl[] };
}
const sites = (u: Usage[]): string[] => u.map((x) => `${x.span.file}:${x.span.line}`).sort();

test('find_usages {name} without merge FAILS on the same-named triplet (ambiguous)', async () => {
  const p: TestProject = await project(FILES);
  try {
    const r = await p.op('find_usages', { name: 'tick' });
    assert.ok(
      'result' in r && !r.result.ok,
      `ambiguous name must fail without merge: ${JSON.stringify(r)}`,
    );
    assert.match(JSON.stringify(r.result.failure), /ambiguous|distinct/i);
  } finally {
    await p.dispose();
  }
});

test('mergeDeclarations unions the triplet into one aggregated answer == cold per-decl union', async () => {
  const p: TestProject = await project(FILES);
  try {
    const data = okResult(
      await p.op('find_usages', { name: 'tick', mergeDeclarations: true, collapseImports: false }),
    );
    const usages = data.usages ?? [];

    // One aggregated output listing the three merged declarations.
    assert.equal(data.mergedDeclarations?.length, 3, 'all three declarations are listed');
    const declFiles = (data.mergedDeclarations ?? []).map((d) => d.span.file).sort();
    assert.deepEqual(declFiles, ['src/a.ts', 'src/b.ts', 'src/c.ts']);

    // Independent oracle: union of each declaration's cold reference sites.
    const oracle = [
      ...coldReferenceSites(p.root, 'src/a.ts', 'tick'),
      ...coldReferenceSites(p.root, 'src/b.ts', 'tick'),
      ...coldReferenceSites(p.root, 'src/c.ts', 'tick'),
    ].sort();
    assert.deepEqual(sites(usages), oracle, 'merged usages == cold per-declaration union');

    // All three call sites are present in the single answer.
    for (const f of ['src/use.ts']) {
      assert.equal(usages.filter((u) => u.span.file === f).length, 3, 'three call sites in use.ts');
    }
  } finally {
    await p.dispose();
  }
});

test('per-site provenance: each usage is attributed to its originating declaration (no silent conflation)', async () => {
  const p: TestProject = await project(FILES);
  try {
    const data = okResult(
      await p.op('find_usages', { name: 'tick', mergeDeclarations: true, collapseImports: false }),
    );
    const usages = data.usages ?? [];
    const merged = data.mergedDeclarations ?? [];
    // Index → which interface file the declaration lives in.
    const declFileByIndex = merged.map((d) => d.span.file);

    // The three call sites are DISJOINT — each binds to exactly one declaration. Map each call
    // site's recorded decl index back to a decl file and confirm it matches the type it called on.
    const callSites = usages.filter((u) => u.role !== 'decl' && u.span.file === 'src/use.ts');
    assert.ok(callSites.length >= 3, 'call sites present');
    for (const u of callSites) {
      assert.ok(
        u.decls !== undefined && u.decls.length === 1,
        `each disjoint site has one decl: ${JSON.stringify(u)}`,
      );
      const declFile = declFileByIndex[u.decls[0] as number];
      assert.ok(declFile !== undefined, 'decl index resolves into mergedDeclarations');
    }
    // The three sites must span all three declarations — proof the merge did not collapse identity.
    const coveredDeclFiles = new Set(
      callSites.map((u) => declFileByIndex[(u.decls as number[])[0] as number]),
    );
    assert.deepEqual([...coveredDeclFiles].sort(), ['src/a.ts', 'src/b.ts', 'src/c.ts']);
  } finally {
    await p.dispose();
  }
});

// The MANAGER's actual scenario: interface-decl + impl — RELATED declarations whose reference sets
// OVERLAP (a call on an I-typed value is a ref of both I.run and C.run). This exercises the
// multi-index accumulation path (`declIndices` gaining a second entry on a shared site) — where
// per-site provenance earns its keep. The disjoint-triplet test above never hits it.
const RELATED_FILES = {
  'tsconfig.json': '{"compilerOptions":{"strict":true}}',
  'src/iface.ts': 'export interface I { run(): void }\n',
  'src/impl.ts':
    "import type { I } from './iface';\n" + 'export class C implements I {\n  run(): void {}\n}\n',
  'src/use.ts':
    "import type { I } from './iface';\n" +
    "import { C } from './impl';\n" +
    'export const viaIface = (x: I): void => x.run();\n' +
    'export const viaImpl = (): void => new C().run();\n',
};

test('mergeDeclarations on RELATED decls (interface + impl): a shared site is attributed to BOTH (multi-index path)', async () => {
  const p: TestProject = await project(RELATED_FILES);
  try {
    const data = okResult(
      await p.op('find_usages', { name: 'run', mergeDeclarations: true, collapseImports: false }),
    );
    const usages = data.usages ?? [];
    const merged = data.mergedDeclarations ?? [];
    assert.ok(merged.length >= 2, `interface + impl both merged: ${JSON.stringify(merged)}`);

    // The accumulation path must fire: at least one reference site is reached via more than one
    // declaration (the interface and the impl share refs), so its `decls` carries ≥2 indices —
    // and the SAME object in the result, never a double-listed duplicate row.
    const shared = usages.filter((u) => u.decls !== undefined && u.decls.length >= 2);
    assert.ok(
      shared.length > 0,
      `a shared site is attributed to both declarations (multi-index): ${JSON.stringify(usages)}`,
    );
    // No site is listed twice (dedup by file|offset held WHILE accumulating provenance).
    const keys = usages.map((u) => `${u.span.file}:${u.span.line}:${u.span.col ?? ''}`);
    assert.equal(
      keys.length,
      new Set(keys).size,
      'each site appears once, never double-listed per decl',
    );
  } finally {
    await p.dispose();
  }
});
