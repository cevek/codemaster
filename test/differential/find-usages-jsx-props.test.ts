// Prop-aware JSX sweep (t-109741): `find_usages {name, props:{…}}` answers "which `<X …/>` sites
// pass THIS prop (with THIS value)" — the audit query behind two shipped miscounts (a design-system
// variant sweep that reported 3 files of 11, and an escape-hatch doc that claimed 7 sites of ~21).
//
// Oracle: HAND-CURATED ground truth per site (§16 — find_usages is pinned against curated truth,
// not a cold findReferences, which would re-run the identical algorithm), PLUS an independent
// textual scan standing in for the fallback the two reports actually used. The load-bearing
// assertions are the ones the textual scan CANNOT satisfy: an aliased/barrel-imported `<B …/>`,
// a non-literal value `{!isView}`, and a `{...spread}` that may carry or override the prop.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { project, assertSpansValid, type TestProject } from '../helpers/project.ts';
import type { OpResult } from '../../src/ops/contracts.ts';

type PropCell = { name: string; kind: 'literal' | 'dynamic'; value: string };
type Usage = {
  span: { file: string; line: number };
  confidence: string;
  props?: PropCell[];
  spread?: true;
};
type Data = {
  usages?: Usage[];
  enclosers?: { name: string; count: number; confidence: string }[];
  total: number;
  excludedByFilter?: number;
  roleBreakdown?: Record<string, number>;
  propsUncertain?: { dynamicValue: number; spreadMaybe: number };
  notes?: string[];
};

const FILES = {
  'tsconfig.json': '{"compilerOptions":{"strict":true,"jsx":"react-jsx","module":"esnext"}}',
  // The base component: `variant` expresses the style (form (b) of the RET-5521 duality).
  'src/button.tsx':
    'export const Button = (p: {\n' +
    '  variant?: string;\n' +
    '  disabled?: boolean;\n' +
    '  count?: number;\n' +
    '  dirtyGuard?: boolean;\n' +
    '  children?: unknown;\n' +
    '}) => <button>{String(p.variant)}</button>;\n',
  // A barrel — a re-export the LS follows and a `<Button` text scan never sees through.
  'src/barrel.ts': "export { Button } from './button';\n",
  // Form (a): the named wrapper. Its INTERNAL <Button variant="contained"/> is a real site —
  // the breadcrumb from the prop question back to the wrapper question.
  'src/wrappers.tsx':
    "import { Button } from './button';\n" + // 1
    'export const BlueButton = (p: { children?: unknown }) => (\n' + // 2
    '  <Button variant="contained">{p.children}</Button>\n' + // 3  ← literal, certain
    ');\n',
  'src/form-a.tsx':
    "import { Button } from './button';\n" + // 1
    'export const FormA = () => <Button variant="contained" />;\n', // 2 ← literal, certain
  // Alias + barrel + the `{'contained'}` spelling: three things at once that a literal
  // `<Button variant="contained"` scan cannot match.
  'src/form-b.tsx':
    "import { Button as B } from './barrel';\n" + // 1
    "export const FormB = () => <B variant={'contained'} />;\n", // 2 ← literal, certain
  'src/form-c.tsx':
    "import { Button } from './button';\n" + // 1
    'export const FormC = (p: { mode: string }) => <Button variant={p.mode} />;\n', // 2 ← DYNAMIC value
  'src/form-d.tsx':
    "import { Button } from './button';\n" + // 1
    'export const FormD = (p: { rest: object }) => <Button {...p.rest} />;\n', // 2 ← spread may CARRY it
  'src/form-e.tsx':
    "import { Button } from './button';\n" + // 1
    'export const FormE = () => <Button variant="text" />;\n', // 2 ← literal outside the set → excluded
  'src/form-f.tsx':
    "import { Button } from './button';\n" + // 1
    'export const FormF = (p: { rest: object }) => (\n' + // 2
    '  <Button variant="text" {...p.rest} />\n' + // 3 ← spread may OVERRIDE the literal
    ');\n',
  // The value-spelling zoo + the amiro escape-hatch shape.
  'src/form-g.tsx':
    "import { Button } from './button';\n" + // 1
    'export const FormG = () => <Button disabled />;\n' + // 2 ← bare attr = literal `true`
    'export const FormH = () => <Button count={0} />;\n' + // 3 ← numeric literal
    'export const FormI = () => <Button dirtyGuard={false} />;\n' + // 4 ← the amiro literal
    'export const FormJ = (p: { isView: boolean }) => <Button dirtyGuard={!p.isView} />;\n', // 5 ← the DYNAMIC one both reports nearly lost
};

function dataOf(r: OpResult): Data {
  assert.ok('result' in r && r.result.ok, JSON.stringify(r));
  return r.result.data as Data;
}
const sitesOf = (d: Data): string[] =>
  (d.usages ?? []).map((u) => `${u.span.file}:${u.span.line}`).sort();

/** The fallback both reports fell back to: a literal scan for `<Button` + `variant=`. Independent
 *  of the op (plain text over the same files) — it is the BASELINE the semantic answer must beat. */
function textualScan(root: string, files: readonly string[]): string[] {
  const hits: string[] = [];
  for (const rel of files) {
    const lines = readFileSync(path.join(root, rel), 'utf8').split('\n');
    lines.forEach((line, i) => {
      // The literal the RET-5521 agent actually grepped for: the tag name AND the value spelling.
      if (line.includes('<Button') && line.includes('variant="contained"')) {
        hits.push(`${rel}:${i + 1}`);
      }
    });
  }
  return hits.sort();
}

const SRC = Object.keys(FILES).filter((f) => f.endsWith('.tsx'));

test('props filter: every site passing variant=contained, including the ones grep cannot see', async () => {
  const p: TestProject = await project(FILES);
  try {
    const r = await p.op('find_usages', {
      name: 'Button',
      file: 'src/button.tsx',
      props: { variant: ['contained'] },
    });
    const d = dataOf(r);
    assertSpansValid(p.root, r);
    const sites = sitesOf(d);

    // The three certain sites — the wrapper's own internal site included (the RET-5521 breadcrumb).
    for (const expected of ['src/wrappers.tsx:3', 'src/form-a.tsx:2', 'src/form-b.tsx:2']) {
      assert.ok(sites.includes(expected), `${expected} missing from ${sites.join(', ')}`);
    }
    // …and the three uncertain ones, KEPT (§3.3) — dropping any is the shipped-miscount bug.
    for (const expected of ['src/form-c.tsx:2', 'src/form-d.tsx:2', 'src/form-f.tsx:3']) {
      assert.ok(sites.includes(expected), `uncertain site ${expected} was dropped`);
    }
    // The definite non-match is excluded, and counted — never silently absent.
    assert.ok(
      !sites.includes('src/form-e.tsx:2'),
      'variant="text" without a spread is not a match',
    );
    // form-e (variant="text") + the four form-g sites that pass no `variant` at all, and carry no
    // spread that could deliver one — every one of them reported, never silently absent (§3.4).
    assert.equal(d.excludedByFilter, 5, 'non-matching jsx sites are reported, not vanished');
    assert.equal(d.total, 6);

    // ⊇ the textual fallback, and STRICTLY more: the alias/barrel site is invisible to it.
    const textual = textualScan(p.root, SRC);
    for (const hit of textual) {
      assert.ok(sites.includes(hit), `semantic answer lost a textual hit: ${hit}`);
    }
    assert.ok(!textual.includes('src/form-b.tsx:2'), 'the textual scan is expected to miss <B …/>');
    assert.ok(sites.length > textual.length, 'the semantic answer must find what the scan cannot');

    // Per-site honesty: value text present, confidence demoted exactly where it must be.
    const byLine = new Map((d.usages ?? []).map((u) => [`${u.span.file}:${u.span.line}`, u]));
    assert.equal(byLine.get('src/form-a.tsx:2')?.confidence, 'certain');
    assert.deepEqual(byLine.get('src/form-b.tsx:2')?.props, [
      { name: 'variant', kind: 'literal', value: 'contained' },
    ]);
    const dyn = byLine.get('src/form-c.tsx:2');
    assert.equal(dyn?.confidence, 'dynamic', 'a non-literal value is dynamic, never certain');
    assert.deepEqual(dyn?.props, [{ name: 'variant', kind: 'dynamic', value: 'p.mode' }]);
    assert.equal(byLine.get('src/form-d.tsx:2')?.spread, true);
    assert.equal(byLine.get('src/form-d.tsx:2')?.confidence, 'dynamic');
    assert.equal(byLine.get('src/form-f.tsx:3')?.confidence, 'dynamic');

    // The TWO uncertainties are counted apart — one merged count would hide which read is needed.
    assert.deepEqual(d.propsUncertain, { dynamicValue: 1, spreadMaybe: 2 });
    const notes = (d.notes ?? []).join('\n');
    assert.match(notes, /NON-LITERAL value/);
    assert.match(notes, /\{\.\.\.spread\}/);
  } finally {
    await p.dispose();
  }
});

test('props value spellings normalize; presence (true) is certain even for a dynamic value', async () => {
  const p: TestProject = await project(FILES);
  try {
    const target = { name: 'Button', file: 'src/button.tsx' };
    // The two spread-bearing sites are candidates for ANY prop question (a spread may carry it) —
    // they ride along at `dynamic`, counted under `spreadMaybe`, never as a certain match.
    const SPREAD = ['src/form-d.tsx:2', 'src/form-f.tsx:3'];
    const certainOf = (d: Data): string[] =>
      (d.usages ?? [])
        .filter((u) => u.confidence === 'certain')
        .map((u) => `${u.span.file}:${u.span.line}`)
        .sort();

    const bare = dataOf(await p.op('find_usages', { ...target, props: { disabled: ['true'] } }));
    assert.deepEqual(
      certainOf(bare),
      ['src/form-g.tsx:2'],
      'a bare attribute is the literal `true`',
    );
    assert.deepEqual(sitesOf(bare), ['src/form-g.tsx:2', ...SPREAD].sort());
    assert.deepEqual(bare.propsUncertain, { dynamicValue: 0, spreadMaybe: 2 });

    const zero = dataOf(await p.op('find_usages', { ...target, props: { count: '0' } }));
    assert.deepEqual(certainOf(zero), ['src/form-g.tsx:3'], '{0} is a literal, not dynamic');

    // The amiro question: `dirtyGuard={false}` — the literal site AND the dynamic one.
    const guard = dataOf(await p.op('find_usages', { ...target, props: { dirtyGuard: 'false' } }));
    assert.deepEqual(certainOf(guard), ['src/form-g.tsx:4']);
    assert.ok(sitesOf(guard).includes('src/form-g.tsx:5'), 'the dynamic {!isView} site is kept');
    assert.deepEqual(guard.propsUncertain, { dynamicValue: 1, spreadMaybe: 2 });

    // The spelling an agent reaches for first: a real `false`, not the string.
    const boolArg = dataOf(await p.op('find_usages', { ...target, props: { dirtyGuard: false } }));
    assert.deepEqual(certainOf(boolArg), ['src/form-g.tsx:4'], '{dirtyGuard:false} === "false"');

    // `true` = "passed at all": presence is PROVEN even when the value is an expression.
    const any = dataOf(await p.op('find_usages', { ...target, props: { dirtyGuard: true } }));
    assert.deepEqual(certainOf(any), ['src/form-g.tsx:4', 'src/form-g.tsx:5']);
    assert.deepEqual(any.propsUncertain, { dynamicValue: 0, spreadMaybe: 2 });
  } finally {
    await p.dispose();
  }
});

test('a props-filtered 0 is not "nobody passes it": the jsx denominator survives', async () => {
  const p: TestProject = await project(FILES);
  try {
    const d = dataOf(
      await p.op('find_usages', {
        name: 'Button',
        file: 'src/button.tsx',
        props: { variant: ['ghost'] },
      }),
    );
    // No literal `ghost` exists anywhere — what survives is exactly the fog: the two spread sites
    // and the one non-literal `variant={p.mode}`, which COULD evaluate to it.
    assert.deepEqual(d.propsUncertain, { dynamicValue: 1, spreadMaybe: 2 });
    assert.equal((d.usages ?? []).filter((u) => u.confidence === 'certain').length, 0);
    assert.ok((d.roleBreakdown?.['jsx'] ?? 0) > 0, 'the role distribution states the denominator');
    assert.equal(
      d.total + (d.excludedByFilter ?? 0),
      d.roleBreakdown?.['jsx'],
      'every jsx site is accounted for: matched + excluded',
    );
  } finally {
    await p.dispose();
  }
});

test('groupBy: the filter applies before the rollup, and a group takes the worst-of confidence', async () => {
  const p: TestProject = await project(FILES);
  try {
    const d = dataOf(
      await p.op('find_usages', {
        name: 'Button',
        file: 'src/button.tsx',
        props: { variant: ['contained'] },
        groupBy: 'enclosing',
      }),
    );
    const byName = new Map((d.enclosers ?? []).map((g) => [g.name, g]));
    assert.ok(byName.has('BlueButton'), 'the wrapper is an encloser of a matching site');
    assert.ok(byName.has('FormA'), 'a direct consumer is an encloser');
    assert.ok(!byName.has('FormE'), 'the filter ran BEFORE the rollup, not as a display filter');
    assert.equal(byName.get('FormA')?.confidence, 'certain');
    assert.equal(
      byName.get('FormC')?.confidence,
      'dynamic',
      'a dynamic site must not roll up as a certain encloser',
    );
    assert.match((d.notes ?? []).join('\n'), /per-site prop VALUES/);
  } finally {
    await p.dispose();
  }
});

test('props with a non-jsx role is refused, never silently rewritten', async () => {
  const p: TestProject = await project(FILES);
  try {
    const r = await p.op('find_usages', {
      name: 'Button',
      file: 'src/button.tsx',
      role: 'call',
      props: { variant: ['contained'] },
    });
    assert.ok('result' in r && !r.result.ok, 'a contradictory role must FAIL');
    assert.match(JSON.stringify(r), /role:'jsx' only/);
  } finally {
    await p.dispose();
  }
});
