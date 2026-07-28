// The DESCENT oracle for the condition chain (t-933867): the same rules applied TOP-DOWN from a
// freshly parsed `ts.createSourceFile` with a condition stack, versus the op's bottom-up climb from
// the site. Different traversal, different mechanics (no cap, no reversal), same claim.
//
// What it discriminates, stated honestly: mechanics — a lost level, a bad reversal, a missed site, a
// blanket-empty degradation. What it does NOT: a wrong RULE — the optional-chain nearest-link rule is
// transliterated here as literally as the rest, and a transliteration cannot audit its own source —
// (the case-expression hole lived in both and this stayed green). That is what the RUNTIME oracle in
// usages-condition-runtime.test.ts is for. Consequently the two implementations must stay separate —
// refactoring them onto a shared helper would turn this file into a tautology (§16).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import ts from 'typescript';
import { SITE_SRC, opChains } from '../fixtures/inline/condition-cases.ts';

// ── oracle 2: the same rules, applied top-down from a fresh parse ────────────────────────────────

function isBoundary(n: ts.Node): boolean {
  return (
    ts.isFunctionDeclaration(n) ||
    ts.isFunctionExpression(n) ||
    ts.isArrowFunction(n) ||
    ts.isMethodDeclaration(n) ||
    ts.isConstructorDeclaration(n) ||
    ts.isGetAccessorDeclaration(n) ||
    ts.isSetAccessorDeclaration(n) ||
    ts.isClassLike(n) ||
    ts.isSourceFile(n)
  );
}

/** The condition `child` sits under within `parent`, computed with the parent already in hand (no
 *  climb) — `null` = no branch, `undefined` = a branch we do not state (the op must say `partial`). */
function pushed(parent: ts.Node, child: ts.Node, sf: ts.SourceFile): string | null | undefined {
  const txt = (n: ts.Node): string => n.getText(sf).replace(/\s+/g, ' ').trim();
  const neg = (n: ts.Expression): string =>
    ts.isPrefixUnaryExpression(n) && n.operator === ts.SyntaxKind.ExclamationToken
      ? txt(n.operand)
      : `!(${txt(n)})`;
  if (ts.isIfStatement(parent)) {
    if (parent.thenStatement === child) return txt(parent.expression);
    if (parent.elseStatement === child) return neg(parent.expression);
    return null;
  }
  if (ts.isConditionalExpression(parent)) {
    if (parent.whenTrue === child) return txt(parent.condition);
    if (parent.whenFalse === child) return neg(parent.condition);
    return null;
  }
  if (ts.isBinaryExpression(parent) && parent.right === child) {
    if (parent.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken)
      return txt(parent.left);
    if (parent.operatorToken.kind === ts.SyntaxKind.BarBarToken) return neg(parent.left);
    if (parent.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken)
      return `${txt(parent.left)} == null`;
    if (parent.operatorToken.kind === ts.SyntaxKind.BarBarEqualsToken) return neg(parent.left);
    if (parent.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandEqualsToken)
      return txt(parent.left);
    if (parent.operatorToken.kind === ts.SyntaxKind.QuestionQuestionEqualsToken)
      return `${txt(parent.left)} == null`;
    return null;
  }
  if (
    (ts.isCallExpression(parent) && parent.arguments.some((arg) => arg === child)) ||
    (ts.isElementAccessExpression(parent) && parent.argumentExpression === child)
  ) {
    let cur: ts.Node = parent;
    let root: ts.Expression | undefined;
    for (;;) {
      if (ts.isNonNullExpression(cur)) {
        cur = cur.expression;
        continue;
      }
      if (
        !ts.isPropertyAccessExpression(cur) &&
        !ts.isElementAccessExpression(cur) &&
        !ts.isCallExpression(cur)
      )
        break;
      if (cur.questionDotToken !== undefined && root === undefined) root = cur.expression;
      cur = cur.expression;
    }
    if (root !== undefined) return `${txt(root)} != null`;
    return null;
  }
  if (ts.isWhileStatement(parent) && parent.statement === child) return txt(parent.expression);
  if (ts.isForStatement(parent) && parent.statement === child)
    return parent.condition === undefined ? null : txt(parent.condition);
  if (ts.isCaseClause(parent)) {
    if (parent.expression === child) return null; // the case expression itself always evaluates
    const clauses = parent.parent.clauses;
    const scrutinee = txt(parent.parent.parent.expression);
    const exprs = [txt(parent.expression)];
    for (let i = clauses.indexOf(parent) - 1; i >= 0; i--) {
      const prev = clauses[i];
      if (prev === undefined || prev.statements.length > 0) break;
      if (!ts.isCaseClause(prev)) return undefined;
      exprs.unshift(txt(prev.expression));
    }
    return exprs.map((e) => `${scrutinee} === ${e}`).join(' || ');
  }
  if (ts.isDefaultClause(parent) || ts.isCatchClause(parent)) return undefined;
  return null;
}

/** Chains for every `F` identifier, by 1-based line, descending with a condition stack. Lines whose
 *  chain touches an unstated branch are returned as `undefined` (compared only for presence). */
function descentOracle(source: string, name: string): Map<number, string[] | undefined> {
  const sf = ts.createSourceFile('site.ts', source, ts.ScriptTarget.ES2022, true);
  const out = new Map<number, string[] | undefined>();
  const walk = (node: ts.Node, stack: string[] | undefined): void => {
    if (ts.isIdentifier(node) && node.text === name) {
      out.set(sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1, stack);
    }
    const base = isBoundary(node) ? [] : stack;
    ts.forEachChild(node, (child) => {
      const add = pushed(node, child, sf);
      if (add === undefined) walk(child, undefined);
      else walk(child, base === undefined ? undefined : add === null ? base : [...base, add]);
    });
  };
  walk(sf, []);
  return out;
}

test('oracle 2 (independent descent): the climb agrees site-for-site with a top-down condition stack', async () => {
  const { rows, dispose } = await opChains();
  try {
    const oracle = descentOracle(SITE_SRC, 'F');
    // Every site the descent found must be reported by the op (no dropped site), and vice versa.
    assert.deepEqual(
      rows.map((r) => r.line).sort((a, b) => a - b),
      [...oracle.keys()].sort((a, b) => a - b),
      'the op and the descent oracle must agree on WHICH lines hold a reference',
    );
    for (const row of rows) {
      const expected = oracle.get(row.line);
      if (expected === undefined) {
        // The descent hit a branch it does not state — the op must disclose, not invent.
        assert.equal(row.partial, true, `line ${row.line}: an unstated branch must set partial`);
        continue;
      }
      assert.deepEqual(row.conditions, expected, `line ${row.line}: chain must match the descent`);
    }
  } finally {
    await dispose();
  }
});
