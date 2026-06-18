// GENERIC classification of an expression's syntactic shape (callArgShapes, §5-L2) — the value
// classifier the call-arg-shape scan applies to each matched call's arguments. Domain-neutral and
// checker-FREE (§19): a literal is read verbatim and `certain`; a bare identifier / member access /
// interpolated template / spread / call is `dynamic` (statically indeterminate — never guessed).
// `array` and `object` recurse to a BOUNDED depth (a hostile deeply-nested literal collapses to
// `other` past the cap, so the walk can never blow the stack or scale unboundedly).

import ts from 'typescript';
import type { RepoRelPath } from '../../core/brands.ts';
import type { Confidence } from '../../core/span.ts';
import { worstOf } from '../../common/confidence/worst-of.ts';
import { spanFromRange } from './spans.ts';
import type { ValueProp, ValueShape } from './call-scan-shared.ts';

/** Recursion ceiling for nested array/object literals — `queryKey` segments are shallow; this is
 *  the §19 bound, not a feature limit. */
const MAX_DEPTH = 4;

export function classifyValue(
  sourceFile: ts.SourceFile,
  rel: RepoRelPath,
  node: ts.Expression,
  depth = 0,
): ValueShape {
  const inner = ts.isParenthesizedExpression(node) ? node.expression : node;
  const span = spanFromRange(sourceFile, rel, inner.getStart(sourceFile), inner.getEnd());

  if (ts.isStringLiteralLike(inner))
    return { kind: 'string', value: inner.text, span, confidence: 'certain' };
  if (ts.isNumericLiteral(inner))
    return { kind: 'number', value: inner.text, span, confidence: 'certain' };
  if (isNegativeNumber(inner)) {
    return { kind: 'number', value: inner.getText(sourceFile), span, confidence: 'certain' };
  }
  if (inner.kind === ts.SyntaxKind.TrueKeyword || inner.kind === ts.SyntaxKind.FalseKeyword) {
    return { kind: 'boolean', value: inner.getText(sourceFile), span, confidence: 'certain' };
  }
  if (inner.kind === ts.SyntaxKind.NullKeyword)
    return { kind: 'null', span, confidence: 'certain' };

  if (ts.isArrayLiteralExpression(inner)) {
    if (depth >= MAX_DEPTH) return { kind: 'other', span, confidence: 'dynamic' };
    const elements = inner.elements.map((el) => classifyValue(sourceFile, rel, el, depth + 1));
    return { kind: 'array', elements, span, confidence: worstOfShapes(elements) };
  }
  if (ts.isObjectLiteralExpression(inner)) {
    if (depth >= MAX_DEPTH) return { kind: 'other', span, confidence: 'dynamic' };
    const props = inner.properties.map((p) => classifyProp(sourceFile, rel, p, depth + 1));
    return {
      kind: 'object',
      props,
      span,
      confidence: worstOf(props.map((p) => p.value.confidence)),
    };
  }
  if (ts.isArrowFunction(inner) || ts.isFunctionExpression(inner)) {
    return { kind: 'function', span, confidence: 'certain' };
  }
  if (ts.isSpreadElement(inner)) return { kind: 'spread', span, confidence: 'dynamic' };
  if (ts.isIdentifier(inner)) return { kind: 'identifier', span, confidence: 'dynamic' };
  if (ts.isPropertyAccessExpression(inner) || ts.isElementAccessExpression(inner)) {
    return { kind: 'property-access', span, confidence: 'dynamic' };
  }
  if (ts.isTemplateExpression(inner)) return { kind: 'template', span, confidence: 'dynamic' };
  if (ts.isCallExpression(inner) || ts.isNewExpression(inner)) {
    return { kind: 'call', span, confidence: 'dynamic' };
  }
  return { kind: 'other', span, confidence: 'dynamic' };
}

/** Classify one object-literal member. A computed / spread / accessor member is never dropped — it
 *  surfaces with a synthetic key (`[computed]` / `...`) so the shape stays complete (§3.4). */
function classifyProp(
  sourceFile: ts.SourceFile,
  rel: RepoRelPath,
  prop: ts.ObjectLiteralElementLike,
  depth: number,
): ValueProp {
  if (ts.isPropertyAssignment(prop)) {
    return {
      key: propKey(prop.name),
      value: classifyValue(sourceFile, rel, prop.initializer, depth),
    };
  }
  if (ts.isShorthandPropertyAssignment(prop)) {
    const span = spanFromRange(sourceFile, rel, prop.name.getStart(sourceFile), prop.name.getEnd());
    return { key: prop.name.text, value: { kind: 'identifier', span, confidence: 'dynamic' } };
  }
  if (ts.isSpreadAssignment(prop)) {
    return { key: '...', value: classifyValue(sourceFile, rel, prop.expression, depth) };
  }
  // A method / accessor member is function-valued.
  const span = spanFromRange(sourceFile, rel, prop.getStart(sourceFile), prop.getEnd());
  const key = prop.name !== undefined ? propKey(prop.name) : '[computed]';
  return { key, value: { kind: 'function', span, confidence: 'certain' } };
}

/** Static property name text, or a `[computed]` marker for a computed/non-literal name. */
function propKey(name: ts.PropertyName): string {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name))
    return name.text;
  return '[computed]';
}

function isNegativeNumber(node: ts.Expression): boolean {
  return (
    ts.isPrefixUnaryExpression(node) &&
    node.operator === ts.SyntaxKind.MinusToken &&
    ts.isNumericLiteral(node.operand)
  );
}

function worstOfShapes(shapes: readonly ValueShape[]): Confidence {
  return worstOf(shapes.map((s) => s.confidence));
}
