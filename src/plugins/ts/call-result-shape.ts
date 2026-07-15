// Per-call-site return-shape triage (t-409060): for a `call`-role reference of a function, the SHAPE
// its result is consumed as at THAT site — the destructured / member-accessed properties, so
// "which return properties does this site actually use" is answered in the one find_usages call
// instead of opening every call site. Purely syntactic + bounded (a short parent walk from the call,
// §19); zero type resolution.
//
// The property-name extraction here is the CALL-RESULT side (given a CallExpression, which of its
// result's properties are read) — distinct from member-refs.ts's token-side destructure detection
// (given a property token, is it inside a binding pattern) and scope-shadow's bound-LOCAL-name
// collection. It reports PROPERTY names (`{a: x}` → `a`, not the local `x`), never guesses a computed
// key, and flags a `...rest` — an unknown remainder is `rest`, never silently dropped (§3.4).

import ts from 'typescript';
import { nodeAt } from './ast-node.ts';

/** How a call's result is consumed at one site. `props` = the known consumed properties
 *  (`const {a,b}=fn()` → [a,b]; `fn().x` → [x]; a discarded `fn();` → []). `rest` flags a `...rest`
 *  or a computed binding key — extra properties beyond `props` may be consumed. `whole` = the result
 *  is bound/passed as a value, so ANY property may be used (a conservative catch-all, never a silent
 *  gap). `props` and `whole` are mutually exclusive. */
export type CallResultShape = { props?: string[]; rest?: true; whole?: true };

/** Property names (+ a `rest` flag) bound by an object-binding-pattern destructure. Reports the
 *  SOURCE property (`{a: x}` → `a`), a nested pattern's top-level key (`{a: {b}}` → `a`), and marks a
 *  `...rest` or a computed/dynamic key as `rest` rather than fabricating a name. */
function bindingPatternProps(pattern: ts.ObjectBindingPattern): CallResultShape {
  const props: string[] = [];
  let rest: true | undefined;
  for (const el of pattern.elements) {
    if (el.dotDotDotToken !== undefined) {
      rest = true;
      continue;
    }
    const key = el.propertyName ?? el.name;
    if (ts.isIdentifier(key)) props.push(key.text);
    else if (ts.isStringLiteralLike(key) || ts.isNumericLiteral(key)) props.push(key.text);
    else rest = true; // a computed property name — an unknown consumed prop; flag, never guess
  }
  return { props, ...(rest !== undefined ? { rest } : {}) };
}

/** Climb through value-preserving wrappers (`await` / parens / non-null `!`) so the call's consumer
 *  is examined, not the wrapper — `const {a} = await fn()` sees the destructure, not the AwaitExpr. */
function unwrapValue(node: ts.Node): ts.Node {
  let value = node;
  for (;;) {
    const p = value.parent;
    if (
      p !== undefined &&
      (ts.isParenthesizedExpression(p) || ts.isAwaitExpression(p) || ts.isNonNullExpression(p)) &&
      p.expression === value
    ) {
      value = p;
    } else {
      return value;
    }
  }
}

/** The CallExpression whose CALLEE is (or wraps) `node` — the reference is on the callee identifier
 *  (`fn` in `fn()`, or the `.fn` of `x.fn()`), so climb only callee-position wrappers. */
function enclosingCall(node: ts.Node): ts.CallExpression | undefined {
  let cur: ts.Node = node;
  for (;;) {
    const parent = cur.parent;
    if (parent === undefined) return undefined;
    if (ts.isCallExpression(parent) && parent.expression === cur) return parent;
    if (
      (ts.isPropertyAccessExpression(parent) && parent.name === cur) ||
      ((ts.isPropertyAccessExpression(parent) ||
        ts.isElementAccessExpression(parent) ||
        ts.isParenthesizedExpression(parent) ||
        ts.isNonNullExpression(parent)) &&
        parent.expression === cur)
    ) {
      cur = parent;
      continue;
    }
    return undefined;
  }
}

function classifyResult(call: ts.CallExpression): CallResultShape {
  const value = unwrapValue(call);
  const parent = value.parent;
  if (parent === undefined) return { whole: true };
  // `const {a,b} = fn()` — the destructure the task is about.
  if (
    ts.isVariableDeclaration(parent) &&
    parent.initializer === value &&
    ts.isObjectBindingPattern(parent.name)
  ) {
    return bindingPatternProps(parent.name);
  }
  // `fn().prop` — a single known property.
  if (
    ts.isPropertyAccessExpression(parent) &&
    parent.expression === value &&
    ts.isIdentifier(parent.name)
  ) {
    return { props: [parent.name.text] };
  }
  // `fn()['prop']` — a string-literal key is known; a computed key is not (→ whole).
  if (ts.isElementAccessExpression(parent) && parent.expression === value) {
    const arg = parent.argumentExpression;
    return arg !== undefined && ts.isStringLiteralLike(arg)
      ? { props: [arg.text] }
      : { whole: true };
  }
  // Bare `fn();` — the result is discarded, so no property is consumed (provably unaffected).
  if (ts.isExpressionStatement(parent) && parent.expression === value) return { props: [] };
  // Bound to a name / passed as an argument / returned / … — may consume any property.
  return { whole: true };
}

/** The result-consumption shape of the call whose callee reference is at `offset` — always a
 *  `CallResultShape` (a `call`-role ref we cannot tie to a CallExpression falls back to the honest
 *  conservative `{whole:true}`, never a silent omission). */
export function callResultShapeAt(sourceFile: ts.SourceFile, offset: number): CallResultShape {
  const node = nodeAt(sourceFile, offset);
  if (node === undefined) return { whole: true };
  const call = enclosingCall(node);
  return call === undefined ? { whole: true } : classifyResult(call);
}
