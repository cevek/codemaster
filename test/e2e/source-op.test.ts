// §3.2 `source` op: the bodies of N symbols in one call. Oracle = the fixture (the bodies
// we wrote are known) + assertSpansValid (every emitted decl span equals the live file).
// Elision is unit-tested against renderSource with a tiny budget so the "counts add up"
// invariant is checked without a 12KB fixture.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { project, assertSpansValid } from '../helpers/project.ts';
import { renderSource } from '../../src/format/render/render-source.ts';

type SourceData = {
  sources: {
    id: string;
    name: string;
    kind: string;
    decl: { text: string };
    rebound?: { from: string; to: string; confidence: string };
    moreDefinitions?: string[];
  }[];
  unresolved?: { target: string; reason: string }[];
};

test('source returns bodies for resolvable targets and an unresolved section for the rest', async () => {
  const p = await project({
    'tsconfig.json': '{"compilerOptions":{"strict":true}}',
    'src/a.ts': 'export const twice = (n: number): number => n * 2;\n',
    'src/b.ts': 'export function thrice(n: number): number {\n  return n * 3;\n}\n',
  });
  try {
    const r = await p.op('source', {
      targets: [{ name: 'twice' }, { name: 'thrice' }, { name: 'ghost' }],
    });
    assert.ok('result' in r && r.result.ok, JSON.stringify(r));
    const data = r.result.data as SourceData;
    assert.equal(data.sources.length, 2, 'both real symbols resolved to a body');
    const byName = new Map(data.sources.map((s) => [s.name, s.decl.text]));
    assert.ok(byName.get('twice')?.startsWith('export const twice'));
    assert.ok(byName.get('thrice')?.includes('return n * 3;'), 'full function body present');
    assert.equal(data.unresolved?.length, 1, "the missing symbol isn't silently dropped");
    assert.match(data.unresolved?.[0]?.reason ?? '', /no symbol named 'ghost'/);
    // Every emitted decl span equals the live file (§16 invariant 1).
    assertSpansValid(p.root, r);
  } finally {
    await p.dispose();
  }
});

test('source surfaces a per-target rebind when a held SymbolId moved (§6, never silent)', async () => {
  const p = await project({
    'tsconfig.json': '{"compilerOptions":{"strict":true}}',
    'src/u.ts': 'export const twice = (n: number): number => n * 2;\n',
  });
  try {
    const search = await p.op('search_symbol', { query: 'twice' });
    assert.ok('result' in search && search.result.ok);
    const id = (search.result.data as { matches: { id: string }[] }).matches[0]?.id;
    assert.ok(id !== undefined);

    // Shift the declaration down — the handle's recorded position is now stale.
    p.write('src/u.ts', '// moved\n// down\nexport const twice = (n: number): number => n * 2;\n');

    const r = await p.op('source', { targets: [{ symbol: id }] });
    assert.ok('result' in r && r.result.ok, JSON.stringify(r));
    const entry = (r.result.data as SourceData).sources[0];
    assert.ok(entry?.rebound !== undefined, 'rebind must be stated on the source entry');
    assert.equal(entry.rebound.from, id);
    assert.equal(entry.rebound.confidence, 'partial');
    assertSpansValid(p.root, r);
  } finally {
    await p.dispose();
  }
});

test('source reports extra definitions instead of silently keeping only the first', async () => {
  const p = await project({
    'tsconfig.json': '{"compilerOptions":{"strict":true}}',
    // Declaration merging: two interface declarations of the same name → multiple defs.
    'src/m.ts': 'export interface Box { a: number; }\nexport interface Box { b: string; }\n',
  });
  try {
    const r = await p.op('source', { targets: [{ name: 'Box' }] });
    assert.ok('result' in r && r.result.ok, JSON.stringify(r));
    const entry = (r.result.data as SourceData).sources[0];
    assert.ok(
      (entry?.moreDefinitions?.length ?? 0) >= 1,
      'a merged/overloaded symbol must report its other definition sites',
    );
  } finally {
    await p.dispose();
  }
});

test('source budget collapses overflow targets to a header line; counts add up', () => {
  const span = (text: string) => ({ file: 'src/x.ts', line: 1, col: 1, text });
  const data = {
    sources: [
      { id: 'ts:a@src/x.ts:1:1', name: 'a', kind: 'function', decl: span('A'.repeat(60)) },
      { id: 'ts:b@src/x.ts:2:1', name: 'b', kind: 'function', decl: span('body-of-b\nmore') },
      { id: 'ts:c@src/x.ts:3:1', name: 'c', kind: 'function', decl: span('body-of-c') },
    ],
  };
  // Budget fits only the first body; the other two collapse to header lines.
  const out = renderSource(data, 60);
  assert.ok(out.includes('A'.repeat(60)), 'first body shown in full');
  assert.ok(!out.includes('body-of-b\nmore'), 'overflow body collapsed');
  assert.match(out, /… source elided for 2 target\(s\)/, 'elided count is explicit and adds up');
  // Header lines for the collapsed targets still name them (first line only).
  assert.ok(out.includes('ts:b@src/x.ts:2:1') && out.includes('ts:c@src/x.ts:3:1'));
});
