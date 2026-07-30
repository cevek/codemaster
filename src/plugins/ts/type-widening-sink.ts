// Classify ONE forward reference of a value into a flow-sink + its widening verdict — the half of
// `trace_type_widening` that is pure per-reference analysis, split from the cross-program fan driver
// (`type-widening.ts`) that decides WHICH references exist and under WHOSE checker they are judged.
//
// Everything here takes its `checker` and `srcType` as arguments and never reaches for a program:
// a verdict is invalid across checkers, so the caller's contract is that both come from the SAME
// program as `refNode`. Keeping that invariant expressible in one signature is why the split runs
// here rather than at a rendering boundary.

import ts from 'typescript';
import type { Span } from '../../core/span.ts';
import { elideType } from '../../common/truncate/elide-type.ts';
import { spanFromRange } from './spans.ts';
import { classifyWidening } from './type-widening-verdict.ts';
import type { TsProjectHost } from './ls-host.ts';
import type { WideningRelation, WideningSink } from './type-widening-view.ts';

/** Classify a single reference's syntactic context into a flow-sink, or `undefined` when the
 *  reference is a plain read (not a place the value is rebound). */
export function resolveSink(
  host: TsProjectHost,
  checker: ts.TypeChecker,
  refNode: ts.Node,
  srcType: ts.Type,
): WideningSink | undefined {
  const parent = refNode.parent;
  // arg → param: cross into the callee via the resolved signature.
  if (
    (ts.isCallExpression(parent) || ts.isNewExpression(parent)) &&
    parent.arguments !== undefined
  ) {
    const idx = parent.arguments.indexOf(refNode as ts.Expression);
    if (idx < 0) return undefined;
    const sig = checker.getResolvedSignature(parent);
    const param =
      sig !== undefined && idx < sig.parameters.length ? sig.parameters[idx] : undefined;
    const paramDecl = param?.valueDeclaration;
    if (param === undefined || paramDecl === undefined || !ts.isParameter(paramDecl)) {
      // Unresolved callee / rest-param boundary — the sink type is unknown; flag it, never guess.
      return boundarySink(
        host,
        refNode,
        'passed-to',
        'call target unresolved — type at this boundary unknown',
      );
    }
    const sinkType = checker.getTypeOfSymbolAtLocation(param, paramDecl);
    const nameNode = ts.isIdentifier(paramDecl.name) ? paramDecl.name : paramDecl;
    return buildSink(
      host,
      checker,
      'passed-to',
      nameNode,
      param.getName(),
      srcType,
      sinkType,
      true,
    );
  }
  // var initializer: `const x = <value>`.
  if (
    ts.isVariableDeclaration(parent) &&
    parent.initializer === refNode &&
    ts.isIdentifier(parent.name)
  ) {
    const varSym = checker.getSymbolAtLocation(parent.name);
    if (varSym === undefined) return undefined;
    const sinkType = checker.getTypeOfSymbolAtLocation(varSym, parent);
    return buildSink(
      host,
      checker,
      'assigned-to',
      parent.name,
      varSym.getName(),
      srcType,
      sinkType,
      true,
    );
  }
  // reassignment: `x = <value>` — a LEAF (the variable holds different values over its lifetime;
  // following it forward would be flow-imprecise, so we report the widening here and stop).
  if (
    ts.isBinaryExpression(parent) &&
    parent.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
    parent.right === refNode &&
    ts.isIdentifier(parent.left)
  ) {
    const lhsSym = checker.getSymbolAtLocation(parent.left);
    if (lhsSym === undefined) return undefined;
    const sinkType = checker.getTypeOfSymbolAtLocation(lhsSym, parent.left);
    return buildSink(
      host,
      checker,
      'reassigned-to',
      parent.left,
      lhsSym.getName(),
      srcType,
      sinkType,
      false,
    );
  }
  // return: widens against the enclosing function's return type (a LEAF — returning into callers
  // is a different value).
  if (ts.isReturnStatement(parent) && parent.expression === refNode) {
    const fn = enclosingFunction(parent);
    if (fn === undefined) return undefined;
    const sig = checker.getSignatureFromDeclaration(fn);
    if (sig === undefined) return undefined;
    const sinkType = checker.getReturnTypeOfSignature(sig);
    const nameNode = fn.name ?? fn;
    const label = `return of ${fn.name?.getText() ?? '<anonymous>'}`;
    return buildSink(host, checker, 'returned-as', nameNode, label, srcType, sinkType, false);
  }
  return undefined;
}

/** Assemble a sink from the widening verdict. `next` is included only when `wantNext` AND the
 *  verdict is not a precision-erasing boundary (`stop`) — the walk must not continue past `any`. */
function buildSink(
  host: TsProjectHost,
  checker: ts.TypeChecker,
  relation: WideningRelation,
  toNameNode: ts.Node,
  label: string,
  srcType: ts.Type,
  sinkType: ts.Type,
  wantNext: boolean,
): WideningSink {
  const verdict = classifyWidening(checker, srcType, sinkType);
  const span = spanOf(host, toNameNode);
  return {
    relation,
    to: { span, label, typeText: typeStr(checker, sinkType) },
    widened: verdict.widened,
    ...(verdict.kind !== undefined ? { kind: verdict.kind } : {}),
    confidence: verdict.confidence,
    ...(verdict.note !== undefined ? { note: verdict.note } : {}),
    ...(wantNext && verdict.stop !== true
      ? { next: { file: span.file, line: span.line, col: span.col } }
      : {}),
  };
}

/** A sink at an unresolvable boundary (an untyped callee): honestly `dynamic`, never a guessed
 *  widening, and a leaf (no `next`) — §3.3 flags the boundary, never bridges it. */
function boundarySink(
  host: TsProjectHost,
  refNode: ts.Node,
  relation: WideningRelation,
  note: string,
): WideningSink {
  return {
    relation,
    to: { span: spanOf(host, refNode), label: refNode.getText(), typeText: 'unknown' },
    widened: false,
    confidence: 'dynamic',
    note,
  };
}

/** Climb to the nearest enclosing function-like declaration whose return type a `return` widens. */
function enclosingFunction(node: ts.Node): ts.SignatureDeclaration | undefined {
  let current: ts.Node | undefined = node.parent;
  while (current !== undefined) {
    if (
      ts.isFunctionDeclaration(current) ||
      ts.isFunctionExpression(current) ||
      ts.isArrowFunction(current) ||
      ts.isMethodDeclaration(current) ||
      ts.isGetAccessorDeclaration(current)
    ) {
      return current;
    }
    current = current.parent;
  }
  return undefined;
}

export function spanOf(host: TsProjectHost, node: ts.Node): Span {
  const sf = node.getSourceFile();
  return spanFromRange(sf, host.relOf(sf.fileName), node.getStart(sf), node.getEnd());
}

/** `typeToString` with NoTruncation then the `common/truncate` chokepoint (`type-widening` `CapId`,
 *  `length-only` marker — `trace_type_widening` does not thread `verbosity:full`) — a silent checker
 *  `…` reads as completeness (§3.4). */
export function typeStr(checker: ts.TypeChecker, type: ts.Type): string {
  return elideType(
    checker.typeToString(type, undefined, ts.TypeFormatFlags.NoTruncation),
    'type-widening',
  );
}
