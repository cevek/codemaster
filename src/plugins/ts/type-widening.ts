// The flow-navigation primitive behind `trace_type_widening` (§5-L2, Phase 6): given a VALUE
// (a variable / parameter), find the immediate FORWARD flow-sinks it reaches in ONE step — the
// places it is rebound with a possibly-wider declared type — and the per-sink widening verdict.
// AST + checker live HERE (the op never touches the LS — §5-L3); the op-level walk drives the
// recursion (depth / visited / node-cap) over the `next` positions this returns.
//
// THE CONTEXTUAL-TYPING TRAP (a silent-zero-hops bug avoided BY DESIGN, not exercised by a test):
// the source type is read at the value's OWN declaration (`getTypeOfSymbolAtLocation(symbol, decl)`),
// NEVER at a use site — at a call-arg slot `getTypeAtLocation` returns the CONTEXTUAL (already-widened)
// param type, so a fresh inline literal would look "already string" and no widening would be reported.
// For this op's input domain (NAMED value / parameter targets) the declaration-site and use-site types
// coincide, so the choice is sound by construction; the §16 fixtures discriminate the classifier, not
// this trap. The sink type is the sink declaration's own type; the comparison is src-at-its-decl vs
// sink-at-its-decl.

import ts from 'typescript';
import type { RepoRelPath } from '../../core/brands.ts';
import type { Confidence, Span } from '../../core/span.ts';
import { elideType } from '../../common/truncate/elide-type.ts';
import { spanFromRange } from './spans.ts';
import { nodeAt } from './ast-node.ts';
import { classifyWidening, type WideningKind } from './type-widening-verdict.ts';
import type { TsProjectHost } from './ls-host.ts';

const REF_SCAN_CAP = 50; // forward references examined per node (never-hang §1; cap reported honestly)

export type WideningRelation = 'assigned-to' | 'passed-to' | 'returned-as' | 'reassigned-to';

export type WideningEndpoint = { span: Span; label: string; typeText: string };

export type WideningSink = {
  relation: WideningRelation;
  to: WideningEndpoint;
  widened: boolean;
  kind?: WideningKind;
  confidence: Confidence;
  note?: string;
  /** Where the forward walk continues (the param/variable the value rebinds to); absent at a leaf
   *  (`returned-as` / `reassigned-to`) or a precision-erasing boundary (`any`/`unknown` — STOP). */
  next?: { file: RepoRelPath; line: number; col: number };
};

export type WideningSinksView = {
  node: WideningEndpoint;
  sinks: WideningSink[];
  truncated?: { shown: number; total: number };
};

/** One forward step from the value at `{abs, offset}`: its own type, and every immediate flow-sink
 *  with a widening verdict. A `string` when the position is not a value with a symbol. */
export function collectWideningSinks(
  host: TsProjectHost,
  abs: string,
  offset: number,
): WideningSinksView | string {
  // One authority program for the checker, the node, AND the references — routed to the type-authority
  // for `abs` so a no-root repo reads the value's type from the member's own-options program, not the
  // fallback primary whose whole-repo glob pollutes it (t-593802). The node MUST come from this same
  // program's source file (a node typed by a different program is unsound — cross-version checker).
  const authority = host.typeAuthorityFor(abs);
  const program = authority.getProgram();
  if (program === undefined) return 'no TS program for this position';
  const sf = program.getSourceFile(abs);
  if (sf === undefined) return 'position is not in any loaded TS program';
  const checker = program.getTypeChecker();
  const node = nodeAt(sf, offset);
  if (node === undefined) return 'no node at the resolved position';
  const symbol = checker.getSymbolAtLocation(node);
  if (symbol === undefined) {
    return 'no symbol at the resolved position — point at a value (variable / parameter)';
  }
  const decl = symbol.valueDeclaration ?? node;
  const srcType = checker.getTypeOfSymbolAtLocation(symbol, decl);
  const nodeEndpoint: WideningEndpoint = {
    span: spanOf(host, node),
    label: symbol.getName(),
    typeText: typeStr(checker, srcType),
  };

  const refs = authority.service.getReferencesAtPosition(abs, offset) ?? [];
  const sinks: WideningSink[] = [];
  let examined = 0;
  let capped = false;
  for (const ref of refs) {
    // Skip the value's own declaration site (a reference, not a forward use).
    if (ref.fileName === abs && ref.textSpan.start === offset) continue;
    if (examined >= REF_SCAN_CAP) {
      capped = true;
      break;
    }
    examined++;
    const refSf = program.getSourceFile(ref.fileName);
    if (refSf === undefined) continue;
    const refNode = nodeAt(refSf, ref.textSpan.start);
    if (refNode === undefined) continue;
    const sink = resolveSink(host, checker, refNode, srcType);
    if (sink !== undefined) sinks.push(sink);
  }
  const view: WideningSinksView = { node: nodeEndpoint, sinks };
  if (capped) view.truncated = { shown: examined, total: refs.length };
  return view;
}

/** Classify a single reference's syntactic context into a flow-sink, or `undefined` when the
 *  reference is a plain read (not a place the value is rebound). */
function resolveSink(
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

function spanOf(host: TsProjectHost, node: ts.Node): Span {
  const sf = node.getSourceFile();
  return spanFromRange(sf, host.relOf(sf.fileName), node.getStart(sf), node.getEnd());
}

/** `typeToString` with NoTruncation then the `common/truncate` chokepoint (`type-widening` `CapId`,
 *  `length-only` marker — `trace_type_widening` does not thread `verbosity:full`) — a silent checker
 *  `…` reads as completeness (§3.4). */
function typeStr(checker: ts.TypeChecker, type: ts.Type): string {
  return elideType(
    checker.typeToString(type, undefined, ts.TypeFormatFlags.NoTruncation),
    'type-widening',
  );
}
