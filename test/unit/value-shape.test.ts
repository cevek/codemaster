// Unit coverage for the value-shape classifier (scan2's leaf) — the branches the call-arg-shape
// differential fixture does not exercise: array spread, boolean/null literals, shorthand / computed
// object keys, negative number, template, and the MAX_DEPTH collapse-to-`other` bound (§19).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import ts from 'typescript';
import { classifyValue } from '../../src/plugins/ts/value-shape.ts';
import type { ValueShape } from '../../src/plugins/ts/call-scan-shared.ts';
import type { RepoRelPath } from '../../src/core/brands.ts';

/** Classify the initializer of `const x = <expr>;`. */
function classify(expr: string): ValueShape {
  const sf = ts.createSourceFile('t.ts', `const x = ${expr};`, ts.ScriptTarget.Latest, true);
  const stmt = sf.statements[0];
  assert.ok(stmt !== undefined && ts.isVariableStatement(stmt));
  const init = stmt.declarationList.declarations[0]?.initializer;
  assert.ok(init !== undefined);
  return classifyValue(sf, 't.ts' as RepoRelPath, init);
}

const kinds = (s: ValueShape): string[] =>
  s.kind === 'array' ? s.elements.map((e) => e.kind) : [];

test('array segments: literals are certain, spread / identifier are dynamic; array worstOf is dynamic', () => {
  const s = classify("['a', ...base, 1, true, null]");
  assert.equal(s.kind, 'array');
  assert.deepEqual(kinds(s), ['string', 'spread', 'number', 'boolean', 'null']);
  assert.equal(s.confidence, 'dynamic'); // the spread/identifier segments demote the whole array
  const all = s.kind === 'array' ? s.elements : [];
  assert.equal(all[0]?.kind === 'string' ? all[0].value : undefined, 'a');
  assert.equal(all[2]?.kind === 'number' ? all[2].value : undefined, '1');
});

test('object props: assignment / shorthand / computed-key / method are classified and never dropped', () => {
  const s = classify("{ a: 'x', b, [k]: 1, fn: () => 1 }");
  assert.equal(s.kind, 'object');
  const props = s.kind === 'object' ? s.props : [];
  assert.deepEqual(
    props.map((p) => `${p.key}:${p.value.kind}`),
    ['a:string', 'b:identifier', '[computed]:number', 'fn:function'],
  );
});

test('negative number stays a certain number; an interpolated template is dynamic', () => {
  assert.equal(classify('-1').kind, 'number');
  assert.equal(classify('`p-${id}`').kind, 'template');
  assert.equal(classify('`plain`').kind, 'string'); // no-substitution template is a static literal
});

test('MAX_DEPTH bound: a hostile deep literal collapses to `other`, never an unbounded walk', () => {
  const s = classify("[[[[['deep']]]]]");
  const collected: string[] = [];
  const walk = (v: ValueShape): void => {
    collected.push(v.kind);
    if (v.kind === 'array') v.elements.forEach(walk);
  };
  walk(s);
  assert.ok(collected.includes('other'), 'the over-deep node collapses to other');
  assert.ok(!collected.includes('string'), 'the over-deep string is never reached (bounded)');
});
