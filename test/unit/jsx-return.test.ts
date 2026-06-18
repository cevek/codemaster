// Unit coverage for the returnsJsx classifier (scan1's leaf): the branches not pinned by the
// function-declarations differential — `&&` / `||`, the bare `return;`, the nested-function
// boundary, and the documented SYNTACTIC interpretation that an INDIRECT return (JSX via a variable
// or a call) is honestly `returnsJsx:false` (checker-free → never guessed, §3/§19), not `dynamic`.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import ts from 'typescript';
import { classifyJsxReturn, type JsxReturn } from '../../src/plugins/ts/jsx-return.ts';

/** Classify the FIRST function-like declaration's body in a TSX snippet. */
function jsxOf(src: string): JsxReturn {
  const sf = ts.createSourceFile('t.tsx', src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let body: ts.ConciseBody | undefined;
  const visit = (n: ts.Node): void => {
    if (body === undefined && (ts.isFunctionDeclaration(n) || ts.isArrowFunction(n))) body = n.body;
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return classifyJsxReturn(body);
}

test('direct return / arrow concise JSX is certain', () => {
  assert.deepEqual(jsxOf('function f() { return <a/>; }'), {
    returnsJsx: true,
    confidence: 'certain',
  });
  assert.deepEqual(jsxOf('const f = () => <a/>;'), { returnsJsx: true, confidence: 'certain' });
});

test('JSX through `&&` / `||` / ternary is partial', () => {
  assert.deepEqual(jsxOf('function f(x){ return x && <a/>; }'), {
    returnsJsx: true,
    confidence: 'partial',
  });
  assert.deepEqual(jsxOf('function f(x){ return x || <a/>; }'), {
    returnsJsx: true,
    confidence: 'partial',
  });
  assert.deepEqual(jsxOf('function f(x){ return x ? <a/> : <b/>; }'), {
    returnsJsx: true,
    confidence: 'partial',
  });
});

test('a mix of a non-JSX value return and a JSX return is partial', () => {
  assert.deepEqual(jsxOf('function f(x){ if (x) return null; return <a/>; }'), {
    returnsJsx: true,
    confidence: 'partial',
  });
});

test('an INDIRECT return (JSX via a variable / call) is honestly false — checker-free, never guessed', () => {
  assert.deepEqual(jsxOf('function f(){ const el = <a/>; return el; }'), {
    returnsJsx: false,
    confidence: 'certain',
  });
  assert.deepEqual(jsxOf('function f(){ return getJsx(); }'), {
    returnsJsx: false,
    confidence: 'certain',
  });
});

test('bare `return;` and no-JSX body are false; a nested function`s JSX does not leak to the outer', () => {
  assert.deepEqual(jsxOf('function f(){ return; }'), { returnsJsx: false, confidence: 'certain' });
  // The inner arrow returns JSX, but `f` returns 1 — the boundary is not crossed.
  assert.deepEqual(jsxOf('function f(){ const g = () => <a/>; return 1; }'), {
    returnsJsx: false,
    confidence: 'certain',
  });
});
