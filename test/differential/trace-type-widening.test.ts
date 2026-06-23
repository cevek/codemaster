// `trace_type_widening` — oracle-backed (§16). The independent oracle is a fresh-from-cold
// `ts.Program` (`coldTypeStringAt`) that reads the RAW type string at each chain position — never
// the op's own classifier, so the comparison is non-circular: the oracle supplies the ground-truth
// types ('red' vs string), the op is the widening classifier under test.
//
// THE DISCRIMINATOR (red→green): fixtures A and B are byte-identical except the parameter type —
// A widens (`'red'` → `string`), B preserves (`'red'` → `'red'`). The op MUST emit a widening hop
// for A and NONE for B. This is also the contextual-typing-trap guard: if the source type were read
// at the ARGUMENT position (not the value's own declaration), A's `'red'` would read as the already-
// widened `string` and produce ZERO widenings — failing A. Fixture C asserts the any-boundary is
// flagged `dynamic` and STOPPED (no hop continues past the `any`).

import assert from 'node:assert/strict';
import test from 'node:test';
import { project, assertSpansValid } from '../helpers/project.ts';
import { coldTypeStringAt } from '../helpers/cold-ls.ts';
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
  truncated: boolean;
  notes?: string[];
  hops: Hop[];
}

function data(r: OpResult): WideningData {
  assert.ok('result' in r && r.result.ok, JSON.stringify(r));
  return r.result.data as unknown as WideningData;
}

const TSCONFIG = '{"compilerOptions":{"strict":true,"target":"es2022","module":"esnext"}}';

test('A: a literal widens to a primitive across a call — emitted as a WIDENS hop', async () => {
  const p = await project({
    'tsconfig.json': TSCONFIG,
    'src/a.ts': [
      'export function paint(x: string): string {',
      '  const s = x;',
      '  return s;',
      '}',
      "const c = 'red';",
      'paint(c);',
    ].join('\n'),
  });
  try {
    // Independent ground truth: the value is the literal `'red'`, the parameter is `string`.
    assert.equal(coldTypeStringAt(p.root, 'src/a.ts', 'c', 0), '"red"');
    assert.equal(coldTypeStringAt(p.root, 'src/a.ts', 'x', 0), 'string');

    const d = data(await p.op('trace_type_widening', { name: 'c', file: 'src/a.ts' }));
    assert.equal(d.widenings, 1, `exactly one widening (c→x); got ${JSON.stringify(d)}`);
    const widened = d.hops.find((h) => h.note?.startsWith('WIDENS'));
    assert.ok(widened !== undefined, 'a WIDENS hop exists');
    assert.equal(widened.from.label, 'c: "red"');
    assert.equal(widened.to.label, 'x: string');
    assert.equal(widened.relation, 'passed-to');
    assert.equal(widened.confidence, 'certain');
    assert.match(widened.note ?? '', /literal-widening/);
    // Recursion crossed INTO the callee: the preserved x→s / s→return hops are present.
    assert.ok(
      d.hops.some((h) => h.relation === 'assigned-to' || h.relation === 'returned-as'),
      'the walk continued past the parameter into the callee body',
    );
    assertSpansValid(p.root, await p.op('trace_type_widening', { name: 'c', file: 'src/a.ts' }));
  } finally {
    await p.dispose();
  }
});

test('B: identical chain but the parameter preserves the literal — NO widening hop', async () => {
  const p = await project({
    'tsconfig.json': TSCONFIG,
    'src/a.ts': ["export function paint(x: 'red'): void {}", "const c = 'red';", 'paint(c);'].join(
      '\n',
    ),
  });
  try {
    // Ground truth: the parameter is the SAME literal — no precision is lost.
    assert.equal(coldTypeStringAt(p.root, 'src/a.ts', 'x', 0), '"red"');

    const d = data(await p.op('trace_type_widening', { name: 'c', file: 'src/a.ts' }));
    assert.equal(
      d.widenings,
      0,
      `no widening when the literal is preserved; got ${JSON.stringify(d)}`,
    );
    assert.ok(!d.hops.some((h) => h.note?.startsWith('WIDENS')), 'no hop is flagged WIDENS');
  } finally {
    await p.dispose();
  }
});

test('C: flowing into `any` is a precision-erasing boundary — dynamic + stopped', async () => {
  const p = await project({
    'tsconfig.json': TSCONFIG,
    'src/a.ts': ["const c = 'red';", 'const d: any = c;'].join('\n'),
  });
  try {
    const d = data(await p.op('trace_type_widening', { name: 'c', file: 'src/a.ts' }));
    const boundary = d.hops.find((h) => h.confidence === 'dynamic');
    assert.ok(boundary !== undefined, 'the any-boundary hop is flagged dynamic');
    assert.match(boundary.note ?? '', /to-any/);
    assert.equal(boundary.relation, 'assigned-to');
    assert.ok(d.widenings >= 1, 'flowing into any is counted as a widening');
    // STOPPED at the boundary: the walk never expands the `any`-typed `d`.
    assert.ok(
      !d.hops.some((h) => h.from.label.startsWith('d:')),
      'no hop continues past the any boundary',
    );
  } finally {
    await p.dispose();
  }
});
