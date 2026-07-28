// Per-site enclosing-CONDITION triage (t-933867): for a reference site, the chain of conditional
// BRANCHES it sits under — `if (isFanCapableTarget(args))`, `owner.id === 'ts' || …` — so "where is X
// called, AND WHEN" is answered in the one find_usages call instead of opening every site to recover
// the surrounding `if`. That "and when" is the normal shape of the question; a bare site list is not.
//
// Purely syntactic + bounded (a parent climb from the site, step-capped, §19 never-hang); zero type
// resolution, no checker. The climb STOPS at the enclosing function boundary: a condition outside a
// nested closure guards the closure's CREATION, not its invocation, so attributing it to a call
// inside would be a fabricated fact (§3).
//
// HONESTY of the two empty forms — they mean different things and must stay distinct:
//   • `conditions: []`      — MEASURED: no enclosing conditional branch inside its function.
//   • the field ABSENT      — not annotated (the opt-in flag is off / grouped or textual row).
// `partial` is set whenever the chain is a SUBSET — a branch whose condition we cannot state soundly
// (a `default:` clause, a `catch` block, an unproven switch fallthrough, an over-cap chain, a
// deep-nesting cap hit) OR an annotation we could not finish for that site (a throw, an unplaceable
// position). It renders as a leading `<unstated>`: the gap is disclosed, never silently dropped from
// the chain (§3.4), and an empty chain is therefore never emitted for a site we merely failed to
// measure. `[]` NEVER means "runs unconditionally" either: an early `return`/`throw` above the site,
// or a conditionally-invoked caller, is outside this syntactic scope and is disclosed as such.

import ts from 'typescript';
import { isFunctionCore, nodeAt } from './ast-node.ts';
import { elideString } from '../../common/truncate/elide-string.ts';
import { CONDITION_TEXT_CAP, type ConditionChain } from '../../common/condition/chain.ts';

/** Max ancestors walked — the climb is O(depth) already; this is the §19 belt-and-braces bound. */
const MAX_STEPS = 300;
/** Max conditions reported (innermost kept — the nearest branch is the load-bearing one). */
const MAX_CONDITIONS = 4;

function flatText(node: ts.Node, sf: ts.SourceFile): string {
  // The `…` marker the elision leaves IS the honesty signal for a cut predicate (§3.4).
  return elideString(node.getText(sf).replace(/\s+/g, ' ').trim(), CONDITION_TEXT_CAP).text;
}

/** `cond` as written. */
function positive(cond: ts.Expression, sf: ts.SourceFile): string {
  return flatText(cond, sf);
}

/** The negation of `cond`. `!x` negates back to `x` (the common `if (!x) … else HERE` shape) —
 *  a text-level simplification of the operand itself, never a rewrite of the predicate's meaning. */
function negative(cond: ts.Expression, sf: ts.SourceFile): string {
  if (ts.isPrefixUnaryExpression(cond) && cond.operator === ts.SyntaxKind.ExclamationToken) {
    return flatText(cond.operand, sf);
  }
  return `!(${flatText(cond, sf)})`;
}

/** Where the climb stops: the shared function CORE plus this walk's own extras — accessors and a
 *  constructor (each its own body), and a CLASS, because a property initializer (`if (x) { class C {
 *  p = F() } }`) runs at construction, not under the enclosing branch, so attributing that branch to
 *  it would be a fabricated fact. */
function isFunctionBoundary(node: ts.Node): boolean {
  return (
    isFunctionCore(node) ||
    ts.isConstructorDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node) ||
    ts.isClassLike(node) ||
    ts.isSourceFile(node)
  );
}

/** Does this clause's body provably NOT fall through to the next one? Syntactic: a trailing
 *  `break`/`return`/`throw`/`continue`, or a block whose last statement is one. Anything else is
 *  UNPROVEN fallthrough → the caller marks the chain `partial` rather than claim the nearest case. */
function terminates(clause: ts.CaseOrDefaultClause): boolean {
  const stmts = clause.statements;
  let last = stmts[stmts.length - 1];
  if (last !== undefined && ts.isBlock(last)) last = last.statements[last.statements.length - 1];
  if (last === undefined) return false;
  return (
    ts.isBreakStatement(last) ||
    ts.isReturnStatement(last) ||
    ts.isThrowStatement(last) ||
    ts.isContinueStatement(last)
  );
}

/** The branch condition of a `case` clause: `<scrutinee> === <case>`, disjoined over the EMPTY
 *  preceding clauses that fall through into it (`case 'a': case 'b': HERE` is `=== 'a' || === 'b'`,
 *  not just the nearest case — the disjunction is the real guard). A preceding clause that has
 *  statements but no proven terminator, or an empty `default:`, makes the disjunction incomplete →
 *  `partial`. */
function caseCondition(clause: ts.CaseClause, sf: ts.SourceFile): { text: string; partial?: true } {
  const block = clause.parent;
  const sw = block.parent;
  const scrutinee = flatText(sw.expression, sf);
  const clauses = block.clauses;
  const exprs: ts.Expression[] = [clause.expression];
  let partial: true | undefined;
  for (let i = clauses.indexOf(clause) - 1; i >= 0; i--) {
    const prev = clauses[i];
    if (prev === undefined) break;
    if (prev.statements.length === 0) {
      if (ts.isCaseClause(prev)) exprs.unshift(prev.expression);
      else partial = true; // an empty `default:` also reaches here — a complement we don't state
      if (partial === true) break;
      continue;
    }
    if (!terminates(prev)) partial = true; // unproven fallthrough into this clause
    break;
  }
  const text = exprs.map((e) => `${scrutinee} === ${flatText(e, sf)}`).join(' || ');
  return { text, ...(partial !== undefined ? { partial } : {}) };
}

/** The LHS of the LEFTMOST optional link in an access/call spine (`a?.b.c(…)` → `a`), or `undefined`
 *  when the spine holds no `?.`. Walking left and keeping the last hit yields the leftmost link,
 *  which is the one that actually guards everything to its right — a nearer link would understate
 *  the guard (`a?.b.c()` throws rather than short-circuits when only `a.b.c` is nullish). */
function optionalGuardRoot(spine: ts.Node): ts.Expression | undefined {
  let cur: ts.Node = spine;
  let found: ts.Expression | undefined;
  for (let step = 0; step < MAX_STEPS; step++) {
    if (
      ts.isPropertyAccessExpression(cur) ||
      ts.isElementAccessExpression(cur) ||
      ts.isCallExpression(cur)
    ) {
      if (cur.questionDotToken !== undefined) found = cur.expression;
      cur = cur.expression;
      continue;
    }
    return found;
  }
  return found;
}

/** One climb step: the condition `child` sits under within `parent`, if any.
 *  `undefined` = this parent contributes no branch condition (the child always evaluates when the
 *  parent does); `{unstated:true}` = it DOES branch but we cannot state it soundly. */
function stepCondition(
  parent: ts.Node,
  child: ts.Node,
  sf: ts.SourceFile,
): { text?: string; unstated?: true; partial?: true } | undefined {
  if (ts.isIfStatement(parent)) {
    if (parent.thenStatement === child) return { text: positive(parent.expression, sf) };
    if (parent.elseStatement === child) return { text: negative(parent.expression, sf) };
    return undefined; // the site is INSIDE the condition — not under it
  }
  if (ts.isConditionalExpression(parent)) {
    if (parent.whenTrue === child) return { text: positive(parent.condition, sf) };
    if (parent.whenFalse === child) return { text: negative(parent.condition, sf) };
    return undefined;
  }
  if (ts.isBinaryExpression(parent) && parent.right === child) {
    const op = parent.operatorToken.kind;
    // Short-circuit RHS: it evaluates only under the LHS's truthiness. `??` is NOT `!lhs`
    // (`0 ?? x` never evaluates `x`) — its real guard is nullishness, so say that.
    if (op === ts.SyntaxKind.AmpersandAmpersandToken) return { text: positive(parent.left, sf) };
    if (op === ts.SyntaxKind.BarBarToken) return { text: negative(parent.left, sf) };
    if (op === ts.SyntaxKind.QuestionQuestionToken)
      return { text: `${flatText(parent.left, sf)} == null` };
    // Logical ASSIGNMENT short-circuits the same way (`cache ||= build()` evaluates the RHS only
    // when `cache` is falsy), so its RHS is as guarded as `||`'s — reporting it unconditional would
    // call a conditional write unconditional.
    if (op === ts.SyntaxKind.BarBarEqualsToken) return { text: negative(parent.left, sf) };
    if (op === ts.SyntaxKind.AmpersandAmpersandEqualsToken)
      return { text: positive(parent.left, sf) };
    if (op === ts.SyntaxKind.QuestionQuestionEqualsToken)
      return { text: `${flatText(parent.left, sf)} == null` };
    return undefined;
  }
  // An OPTIONAL-CHAIN argument (`logger?.info(fmt(x))`, `a?.[k(x)]`): the whole chain short-circuits
  // when the optional link's LHS is nullish, so the argument is not evaluated at all. Far commoner
  // than any other shape here — leaving it out read as "called unconditionally".
  if (
    (ts.isCallExpression(parent) || ts.isElementAccessExpression(parent)) &&
    parent.expression !== child
  ) {
    const root = optionalGuardRoot(parent);
    return root === undefined ? undefined : { text: `${flatText(root, sf)} != null` };
  }
  // A `while`/`for` test guards the body; `for..of`/`for..in`/`do..while` bodies carry no boolean
  // branch condition (a do-while body runs at least once; an empty iterable is not a guard), so
  // they contribute nothing — see the scope disclosure in find_usages' note.
  if (ts.isWhileStatement(parent) && parent.statement === child)
    return { text: positive(parent.expression, sf) };
  if (ts.isForStatement(parent) && parent.statement === child && parent.condition !== undefined)
    return { text: positive(parent.condition, sf) };
  // A site in the clause's own EXPRESSION (`switch (k) { case F(): … }`) evaluates whenever the
  // switch does — it is not under `k === F()`. Same rule as the `if`-condition case above; claiming
  // otherwise would report a site as guarded by the comparison it is part of.
  if (ts.isCaseClause(parent))
    return parent.expression === child ? undefined : caseCondition(parent, sf);
  // `default:` is the complement of the whole case set, and a `catch` block runs only if the try
  // threw — both are real branches whose condition we do not state. Disclosed, never dropped.
  if (ts.isDefaultClause(parent)) return { unstated: true };
  if (ts.isCatchClause(parent)) return { unstated: true };
  return undefined;
}

/** The enclosing conditional-branch chain of the site at `offset` — always a `ConditionChain`, never
 *  a guessed condition.
 *
 *  Every way this can fall short is `partial`, never a bare empty chain: a position we cannot place,
 *  the step cap cut short, or a throw anywhere in the climb (`getText` on a node without real backing
 *  text, an unexpected AST shape) — the last degrades THIS ONE site to what was gathered, so one bad
 *  annotation never fails the whole find_usages answer (§3.4 / CONTRIBUTING "never crash"). An empty
 *  chain is emitted ONLY as a completed measurement. */
export function conditionChainAt(sourceFile: ts.SourceFile, offset: number): ConditionChain {
  const inner: string[] = []; // innermost → outermost while climbing; reversed at the end
  let partial: true | undefined;
  try {
    const node = nodeAt(sourceFile, offset);
    // A position we cannot place is NOT a measurement of "no branch" — say subset, not empty (§3.4).
    if (node === undefined) return { conditions: [], partial: true };
    let child: ts.Node = node;
    // `reachedTop` distinguishes a climb that ENDED at the function boundary (the chain is whole)
    // from one the step cap cut short (branches above are unexamined → subset, like every other cap
    // in this file).
    let reachedTop = false;
    for (let step = 0; step < MAX_STEPS; step++) {
      const parent: ts.Node | undefined = child.parent;
      if (parent === undefined || isFunctionBoundary(parent)) {
        reachedTop = true;
        break;
      }
      const found = stepCondition(parent, child, sourceFile);
      if (found?.unstated === true) partial = true;
      else if (found?.text !== undefined) {
        if (inner.length < MAX_CONDITIONS) inner.push(found.text);
        else partial = true; // over the cap: the outer conditions exist but are not listed
        if (found.partial === true) partial = true;
      }
      child = parent;
    }
    if (!reachedTop) partial = true;
  } catch {
    partial = true; // what we gathered stands; the rest is disclosed as unstated, not claimed
  }
  return { conditions: inner.reverse(), ...(partial !== undefined ? { partial } : {}) };
}
