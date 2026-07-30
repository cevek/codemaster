// t-467009 / t-919920 — `trace_type_widening` read its forward references from ONE program, so a
// flow-sink living only in a SIBLING program was invisible and the trace answered a bare
// `widenings=0 found=0` that reads as "the type never widens". These tests pin the fix in both
// directions: the fan must FIND the sibling sink and state its scope per program, and it must never
// judge one program's reference with another program's source type.
//
// Oracles (§16 — a fixture is input, never proof):
//   · `coldTypeStringAt` over the SIBLING config — an independent cold `ts.Program` supplying the
//     ground-truth types the widening classifier is judged against ('red' vs string);
//   · `coldFindReferences` over the PRIMARY config — proof that the fixture actually discriminates
//     (the sink really is invisible to the primary program alone).
// The negative arm asserts the VERDICT (kind/confidence), not the presence of the hop: a fan that
// reused ONE source type across every program's references still emits the hop — with a different
// widening kind — so a presence assertion cannot catch that mutation.

import assert from 'node:assert/strict';
import test from 'node:test';
import { project } from '../helpers/project.ts';
import { coldFindReferences } from '../helpers/cold-ls.ts';
import { coldTypeStringAt } from '../helpers/cold-type-string.ts';
import type { OpResult } from '../../src/ops/contracts.ts';

interface Hop {
  from: { label: string };
  to: { label: string };
  relation: string;
  confidence: string;
  note?: string;
}
interface WideningData {
  widenings: number;
  found: number;
  complete?: false;
  programsScanned?: string[];
  programsSkipped?: string[];
  undiscoveredPrograms?: string[];
  notes?: string[];
  hops: Hop[];
}

function data(r: OpResult): WideningData {
  assert.ok('result' in r && r.result.ok, JSON.stringify(r));
  return r.result.data as unknown as WideningData;
}

const STRICT = '{"strict":true,"module":"esnext","moduleResolution":"bundler","target":"es2022"}';
const LAX = '{"strict":false,"module":"esnext","moduleResolution":"bundler","target":"es2022"}';

/** A src-declared value whose ONLY forward sink lives in the test program. */
const CROSS = {
  'tsconfig.json': `{"compilerOptions":${STRICT},"include":["src"]}`,
  'tsconfig.test.json': `{"compilerOptions":${STRICT},"include":["src","test"]}`,
  'src/v.ts': "export const color = 'red';\n",
  'test/uses.test.ts':
    "import { color } from '../src/v';\n" +
    'export function paint(x: string): void {\n  void x;\n}\n' +
    'paint(color);\n',
};

/** Two programs that type ONE value differently: with `strictNullChecks` off the declared
 *  `'red' | undefined` collapses to `'red'`. The sink lives only in the lax program, so the verdict
 *  it gets depends on WHICH program's source type the fan compared. */
const DIVERGENT = {
  'tsconfig.json': `{"compilerOptions":${STRICT},"include":["src"]}`,
  'tsconfig.lax.json': `{"compilerOptions":${LAX},"include":["src","lax"]}`,
  'src/v.ts': "export const v: 'red' | undefined = 'red';\n",
  'lax/only.ts':
    "import { v } from '../src/v';\n" +
    'export function take(x: string): void {\n  void x;\n}\n' +
    'take(v);\n',
};

test('the fan finds a sink that lives ONLY in a sibling program, and names the scope per program', async () => {
  const p = await project(CROSS);
  try {
    // Oracle 1 — the ground-truth types the classifier must produce a widening from.
    assert.equal(coldTypeStringAt(p.root, 'src/v.ts', 'color', 0, 'tsconfig.test.json'), '"red"');
    assert.equal(
      coldTypeStringAt(p.root, 'test/uses.test.ts', 'x', 0, 'tsconfig.test.json'),
      'string',
    );
    // Oracle 2 — the fixture discriminates: the primary program alone cannot see the sink.
    assert.deepEqual(
      coldFindReferences(p.root, 'src/v.ts', 'color', 'tsconfig.json'),
      ['src/v.ts'],
      'the primary program sees only the declaration — the sink is sibling-only',
    );

    const d = data(await p.op('trace_type_widening', { name: 'color', file: 'src/v.ts' }));
    assert.equal(d.widenings, 1, `the sibling-only widening is found; got ${JSON.stringify(d)}`);
    const widened = d.hops.find((h) => h.note?.startsWith('WIDENS'));
    assert.ok(widened !== undefined, 'a WIDENS hop exists');
    assert.equal(widened.from.label, 'color: "red"');
    assert.equal(widened.to.label, 'x: string');
    assert.equal(widened.confidence, 'certain');
    assert.match(widened.note ?? '', /literal-widening/);
    // The sibling's verdict is attributed to the program whose checker produced it.
    assert.match(widened.note ?? '', /prog tsconfig\.test\.json/);

    // The positive scope, per program, WITH its denominator — this is what stops a small reference
    // count being read as "traced the repo" (t-919920).
    const scope = d.programsScanned ?? [];
    assert.ok(
      scope.some((s) => s.startsWith('tsconfig.json:')),
      `the primary program is named: ${JSON.stringify(scope)}`,
    );
    const sibling = scope.find((s) => s.startsWith('tsconfig.test.json:'));
    assert.ok(sibling !== undefined, `the sibling program is named: ${JSON.stringify(scope)}`);
    assert.match(sibling, /\d+ forward reference\(s\), \d+\/\d+ checked/);
    // A complete trace carries no `complete` key and no floor prose.
    assert.equal(d.complete, undefined, 'a complete trace is not marked incomplete');
  } finally {
    await p.dispose();
  }
});

test('a source type never leaks across programs: the sibling sink is judged with the SIBLING type', async () => {
  const p = await project(DIVERGENT);
  try {
    // Oracle: the two configs genuinely disagree about the value's own type, so this fixture can
    // discriminate at all. (Under `strictNullChecks:false` the `| undefined` is stripped.)
    assert.equal(
      coldTypeStringAt(p.root, 'src/v.ts', 'v', 0, 'tsconfig.json'),
      '"red" | undefined',
      'oracle: the strict program types the value as a union',
    );
    assert.equal(
      coldTypeStringAt(p.root, 'src/v.ts', 'v', 0, 'tsconfig.lax.json'),
      '"red"',
      'oracle: the lax program types the SAME value as a bare literal — the configs disagree',
    );

    const d = data(await p.op('trace_type_widening', { name: 'v', file: 'src/v.ts' }));
    const hop = d.hops.find((h) => h.to.label.startsWith('x:'));
    assert.ok(hop !== undefined, `the lax-only sink is reported; got ${JSON.stringify(d)}`);
    // THE LOAD-BEARING ASSERTION. Judged with the lax program's own source type (`"red"`, a
    // literal) the verdict is `literal-widening`; judged with the authority's union it would be a
    // different kind — or no widening at all — while the hop itself still appears. So this asserts
    // the VERDICT, which a presence check cannot discriminate.
    assert.match(hop.note ?? '', /WIDENS \(literal-widening\)/, `verdict: ${hop.note}`);
    assert.equal(hop.confidence, 'certain');
    assert.match(hop.note ?? '', /prog tsconfig\.lax\.json/);
    // The divergence itself is disclosed: the endpoint label is the AUTHORITY's type, so the hop
    // must say which type the comparison actually used.
    assert.match(hop.note ?? '', /source reads as "red" there/);
  } finally {
    await p.dispose();
  }
});

test('emptiness carries HOW it was established: a complete fan states the verdict, an incomplete one refuses it', async () => {
  const complete = await project({
    'tsconfig.json': `{"compilerOptions":${STRICT},"include":["src"]}`,
    'src/v.ts': "export const lonely = 'blue';\n",
  });
  try {
    const d = data(await complete.op('trace_type_widening', { name: 'lonely', file: 'src/v.ts' }));
    assert.equal(d.found, 0);
    assert.equal(d.complete, undefined, 'a fully consulted fan is not marked incomplete');
    const note = (d.notes ?? []).join('\n');
    assert.match(note, /never assigned, passed, returned or reassigned onward/);
    assert.doesNotMatch(
      note,
      /NOT proof/,
      'a complete trace must not dress its verdict as a floor',
    );
  } finally {
    await complete.dispose();
  }

  // Same value, same absence — but a repo tsconfig codemaster never loaded makes the SAME `0` a
  // floor, and the answer must say so instead of asserting the value never flows.
  const incomplete = await project({
    'tsconfig.json': `{"compilerOptions":${STRICT},"include":["src"]}`,
    'src/v.ts': "export const lonely = 'blue';\n",
    'sub/tsconfig.json': `{"compilerOptions":${STRICT},"include":["."]}`,
    'sub/q.ts': 'export const q = 1;\n',
  });
  try {
    const d = data(
      await incomplete.op('trace_type_widening', { name: 'lonely', file: 'src/v.ts' }),
    );
    assert.equal(d.found, 0);
    assert.equal(d.complete, false, 'an unloaded repo tsconfig demotes the trace');
    assert.deepEqual(d.undiscoveredPrograms, ['sub/tsconfig.json']);
    const note = (d.notes ?? []).join('\n');
    assert.match(note, /the trace is INCOMPLETE/);
    assert.match(note, /!! LOWER BOUND/);
  } finally {
    await incomplete.dispose();
  }
});
