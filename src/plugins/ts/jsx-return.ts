// SYNTACTIC "does this function return JSX?" — a TSX-LANGUAGE fact (framework-neutral: Preact /
// Solid emit JSX too), so it lives in the ts plugin with NO react convention (PascalCase / `use*`
// live in plugins/react, §4-§5). Checker-FREE (§19): we observe a JSX node in a return position, we
// never ask the type checker for a return TYPE (that would be an O(declarations) semantic sweep). A
// function that returns JSX only through an intermediate variable (`const el = <x/>; return el;`) is
// honestly UNDER-reported (`returnsJsx:false`) — never guessed.
//
// Confidence (§3.3): a direct `return <x/>` / arrow `=> <x/>` is `certain`; JSX reached only through
// a ternary / `&&` / `||`, or a function with a mix of JSX and non-JSX value returns, is `partial`
// (honest under-confidence — react still classifies it). `dynamic` is NOT produced here; it is the
// caller's verdict for wrapper-inferred JSX (a `forwardRef(() => <x/>)` const).

import ts from 'typescript';
import type { Confidence } from '../../core/span.ts';

export type JsxReturn = { returnsJsx: boolean; confidence: Confidence };

/** Grade one return expression for JSX: `direct` (a JSX node, possibly parenthesized),
 *  `conditional` (JSX inside a ternary / `&&` / `||`), or `none` (no statically-visible JSX). */
type Grade = 'direct' | 'conditional' | 'none';

/** Classify the JSX-return shape of a function-like body. `body` is the arrow concise expression,
 *  a block, or `undefined` (an overload signature) → not JSX. */
export function classifyJsxReturn(body: ts.ConciseBody | undefined): JsxReturn {
  if (body === undefined) return { returnsJsx: false, confidence: 'certain' };
  if (!ts.isBlock(body)) return verdict([gradeExpr(body)]); // arrow concise body
  return verdict(collectReturnGrades(body));
}

/** Aggregate per-return grades into the final verdict. `certain` only when every value-returning
 *  path yields DIRECT JSX; any conditional JSX, or a mix with a non-JSX value return, is `partial`. */
function verdict(grades: readonly Grade[]): JsxReturn {
  const hasJsx = grades.some((g) => g !== 'none');
  if (!hasJsx) return { returnsJsx: false, confidence: 'certain' };
  const anyConditional = grades.some((g) => g === 'conditional');
  const anyNone = grades.some((g) => g === 'none');
  const confidence: Confidence = anyConditional || anyNone ? 'partial' : 'certain';
  return { returnsJsx: true, confidence };
}

/** Collect a grade per `return <expr>` in a block, WITHOUT crossing into nested function bodies
 *  (their returns are their own). A bare `return;` contributes `none`. */
function collectReturnGrades(block: ts.Block): Grade[] {
  const grades: Grade[] = [];
  const visit = (node: ts.Node): void => {
    if (isFunctionLike(node)) return; // a nested function's returns belong to it, not us
    if (ts.isReturnStatement(node)) {
      grades.push(node.expression === undefined ? 'none' : gradeExpr(node.expression));
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(block, visit);
  return grades;
}

function gradeExpr(expr: ts.Expression): Grade {
  const e = unwrapParens(expr);
  if (isJsx(e)) return 'direct';
  if (ts.isConditionalExpression(e)) {
    return anyJsx(gradeExpr(e.whenTrue), gradeExpr(e.whenFalse));
  }
  if (ts.isBinaryExpression(e) && isLogical(e.operatorToken.kind)) {
    return anyJsx(gradeExpr(e.left), gradeExpr(e.right));
  }
  return 'none';
}

/** Either branch yields JSX → the whole expression reaches JSX conditionally. */
function anyJsx(a: Grade, b: Grade): Grade {
  return a !== 'none' || b !== 'none' ? 'conditional' : 'none';
}

function isJsx(node: ts.Node): boolean {
  return ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node) || ts.isJsxFragment(node);
}

function isLogical(kind: ts.SyntaxKind): boolean {
  return (
    kind === ts.SyntaxKind.AmpersandAmpersandToken ||
    kind === ts.SyntaxKind.BarBarToken ||
    kind === ts.SyntaxKind.QuestionQuestionToken
  );
}

function unwrapParens(expr: ts.Expression): ts.Expression {
  let e = expr;
  while (ts.isParenthesizedExpression(e)) e = e.expression;
  return e;
}

function isFunctionLike(node: ts.Node): boolean {
  return (
    ts.isArrowFunction(node) ||
    ts.isFunctionExpression(node) ||
    ts.isFunctionDeclaration(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node)
  );
}
