// Syntactic extraction for `discrimination_sites` (§5-L2): a `switch` statement or the HEAD of an
// `if/else-if` chain → a `RawSite` (scrutinee object, discriminant name, the case/branch literal
// nodes, default/else presence). CHECKER-FREE — pure AST, the `function-declarations.ts` precedent;
// the type resolution (identity gate + covers) lives in discrimination-sites.ts.
//
// V1 SCOPE (honest under-coverage, disclosed in the op notes): if-chains match only `X.disc === lit`
// (or `==`) branches chained via `else if`; a `!==`/`!=`, `in`-narrowing, type-guard call, negated
// early-return, or compound `&&`/`||` condition does NOT contribute a covered value (flagged). A
// computed `obj[expr]` scrutinee is not read (dynamic). Under-collects; never fabricates a cover.

import ts from 'typescript';

export type RawSite = {
  kind: 'switch' | 'if-chain';
  /** The `switch`/`if` keyword node — the proof span anchor. */
  keyword: ts.Node;
  /** Verbatim scrutinee text (`f.kind`, `spec.type.kind`, `x`). */
  scrutineeText: string;
  /** The object whose type must BE T (property-access scrutinee `obj.disc`). */
  scrutineeObj: ts.Expression | undefined;
  /** The whole scrutinee, when it is a bare value of type T (`switch(x)` on a literal union). */
  bareScrutinee: ts.Expression | undefined;
  /** Discriminant property name for a property-access scrutinee; `undefined` for bare mode. */
  discriminant: string | undefined;
  /** Case-clause / branch comparison literal nodes — their resolved types are the covered set. */
  caseExprs: ts.Expression[];
  hasDefault: boolean;
  /** A case/branch value that could not be read as a literal (computed / negated) — demotes to partial. */
  unreadableCase: boolean;
};

type Scrutinee = {
  obj: ts.Expression | undefined;
  bare: ts.Expression | undefined;
  disc: string | undefined;
  /** Element-access `obj['k']` — object-identity still gates, but the disc is string-only → partial. */
  elementAccess: boolean;
};

/** Classify a scrutinee expression into { object + discriminant } (property access), or a bare value. */
function classifyScrutinee(expr: ts.Expression): Scrutinee | undefined {
  if (ts.isPropertyAccessExpression(expr)) {
    return { obj: expr.expression, bare: undefined, disc: expr.name.text, elementAccess: false };
  }
  if (ts.isElementAccessExpression(expr) && ts.isStringLiteralLike(expr.argumentExpression)) {
    return {
      obj: expr.expression,
      bare: undefined,
      disc: expr.argumentExpression.text,
      elementAccess: true,
    };
  }
  if (ts.isIdentifier(expr))
    return { obj: undefined, bare: expr, disc: undefined, elementAccess: false };
  return undefined;
}

/** Analyze a `switch` statement into a RawSite (always defined — identity gating happens later). */
export function analyzeSwitch(sf: ts.SourceFile, node: ts.SwitchStatement): RawSite | undefined {
  const s = classifyScrutinee(node.expression);
  if (s === undefined) return undefined;
  const caseExprs: ts.Expression[] = [];
  let hasDefault = false;
  for (const clause of node.caseBlock.clauses) {
    if (ts.isDefaultClause(clause)) hasDefault = true;
    else caseExprs.push(clause.expression);
  }
  return {
    kind: 'switch',
    keyword: node,
    scrutineeText: node.expression.getText(sf),
    scrutineeObj: s.obj,
    bareScrutinee: s.bare,
    discriminant: s.disc,
    caseExprs,
    hasDefault,
    unreadableCase: s.elementAccess,
  };
}

const EQ = new Set<ts.SyntaxKind>([
  ts.SyntaxKind.EqualsEqualsEqualsToken,
  ts.SyntaxKind.EqualsEqualsToken,
]);

/** A syntactic literal operand (`'x'`, `5`, `true`) — the side of an `===` that is NOT the scrutinee. */
function isLiteralOperand(n: ts.Expression): boolean {
  return (
    ts.isStringLiteralLike(n) ||
    ts.isNumericLiteral(n) ||
    n.kind === ts.SyntaxKind.TrueKeyword ||
    n.kind === ts.SyntaxKind.FalseKeyword
  );
}

/** Split an `X === lit` condition into its scrutinee expression + literal node, either operand order. */
function splitEquality(
  cond: ts.Expression,
): { scrutinee: ts.Expression; literal: ts.Expression } | undefined {
  if (!ts.isBinaryExpression(cond) || !EQ.has(cond.operatorToken.kind)) return undefined;
  if (isLiteralOperand(cond.right)) return { scrutinee: cond.left, literal: cond.right };
  if (isLiteralOperand(cond.left)) return { scrutinee: cond.right, literal: cond.left };
  return undefined;
}

/** Is this `if` the HEAD of a chain (not the `else if` tail of an outer `if`)? */
export function isIfChainHead(node: ts.IfStatement): boolean {
  return !(ts.isIfStatement(node.parent) && node.parent.elseStatement === node);
}

/** Analyze an `if/else-if` chain head. The scrutinee is taken from the HEAD branch (where the value
 *  is not yet narrowed — later branches narrow T away, so identity is gated on the head only). */
export function analyzeIfChain(sf: ts.SourceFile, head: ts.IfStatement): RawSite | undefined {
  const first = splitEquality(head.expression);
  if (first === undefined) return undefined;
  const s = classifyScrutinee(first.scrutinee);
  if (s === undefined) return undefined;
  const headText = first.scrutinee.getText(sf); // consistency: every branch compares the SAME scrutinee
  const caseExprs: ts.Expression[] = [];
  let unreadableCase = s.elementAccess;
  let cur: ts.IfStatement | undefined = head;
  let hasDefault = false;
  while (cur !== undefined) {
    const eq = splitEquality(cur.expression);
    if (eq !== undefined && eq.scrutinee.getText(sf) === headText) {
      caseExprs.push(eq.literal);
    } else {
      unreadableCase = true; // a `!==` / compound / mismatched-scrutinee branch — not a clean cover
    }
    const elseStmt: ts.Statement | undefined = cur.elseStatement;
    if (elseStmt !== undefined && ts.isIfStatement(elseStmt)) cur = elseStmt;
    else {
      hasDefault = elseStmt !== undefined; // a bare trailing `else`
      cur = undefined;
    }
  }
  return {
    kind: 'if-chain',
    keyword: head,
    scrutineeText: first.scrutinee.getText(sf),
    scrutineeObj: s.obj,
    bareScrutinee: s.bare,
    discriminant: s.disc,
    caseExprs,
    hasDefault,
    unreadableCase,
  };
}
