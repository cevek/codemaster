// Cross-tier observation (§5-L2): the TS plugin is the one that *sees* JSX — so it exposes the
// class tokens applied via string `className="foo bar"` (and the common `clsx`/`classnames`
// helpers); the scss plugin asks for them to decide whether a GLOBAL (non-`.module.*`) sheet's
// class is live. A generic SYNTACTIC scan (JSX is a TS-language construct — the
// `jsxCallSites`/`functionDeclarations` precedent), zero framework policy here. Whole-program,
// bounded (one visit per node, finite per file — the same posture as `scanCssModuleUsages`).
//
// HONESTY (§3.3/§3.4): the scan OVER-collects — a computed/dynamic className (`className={expr}`,
// a template interpolation, a `getClass()` call) contributes NO token and is simply not resolved,
// never guessed. Over-collection is the safe direction for a "prove dead" query: a spurious token
// only ever keeps a class LISTED-as-live (a missed dead class), never fabricates a dead one. The
// consumer (find_unused_scss_classes) unions these tokens into GLOBAL sheets only and still leaves
// an unmatched global class `partial` — index.html / `classList.add` / DOM writes are unseen.

import ts from 'typescript';
import type { TsProjectHost } from './ls-host.ts';
import { programFileGroups } from './program/project-files.ts';

/** Class tokens observed in JSX `className`/`class` string literals + `clsx`-family string args
 *  across every loaded program. No per-sheet attribution — a global class name is applied by a
 *  bare string, so the token set is a flat global-namespace pool. */
export type ClassNameLiteralsView = {
  tokens: ReadonlySet<string>;
};

/** Callee names whose STRING arguments / object KEYS are class-name lists (the near-universal
 *  className helpers). Matched syntactically by name (an over-collecting heuristic — a same-named
 *  local only adds tokens, never removes a real dead class). */
const CLASS_UTIL_CALLEES = new Set(['clsx', 'classnames', 'classNames', 'cn', 'cx']);

export function scanClassNameLiterals(host: TsProjectHost): ClassNameLiteralsView {
  const tokens = new Set<string>();
  for (const { files } of programFileGroups(host)) {
    for (const sourceFile of files) scanFile(sourceFile, tokens);
  }
  return { tokens };
}

function scanFile(sourceFile: ts.SourceFile, tokens: Set<string>): void {
  const visit = (node: ts.Node): void => {
    // className="foo bar" / className={ … }
    if (ts.isJsxAttribute(node) && isClassNameAttr(node) && node.initializer !== undefined) {
      harvest(node.initializer, tokens);
    }
    // clsx('a', cond && 'b', { active: x }) — anywhere, since the result may be stored then applied.
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      CLASS_UTIL_CALLEES.has(node.expression.text)
    ) {
      for (const arg of node.arguments) harvest(arg, tokens);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
}

function isClassNameAttr(attr: ts.JsxAttribute): boolean {
  const name = ts.isIdentifier(attr.name) ? attr.name.text : attr.name.getText();
  return name === 'className' || name === 'class';
}

/** Recursively pull class tokens from a static-string-bearing expression: string/template
 *  literals, the two conditional/logical branches, array/object (clsx) forms, and nested
 *  `clsx(...)`. A bare identifier / member / non-util call is dynamic → no token (never guessed). */
function harvest(node: ts.Node, tokens: Set<string>): void {
  if (ts.isJsxExpression(node)) {
    if (node.expression !== undefined) harvest(node.expression, tokens);
    return;
  }
  if (ts.isStringLiteralLike(node)) {
    addTokens(node.text, tokens);
    return;
  }
  if (ts.isTemplateExpression(node)) {
    addTokens(node.head.text, tokens);
    for (const span of node.templateSpans) {
      harvest(span.expression, tokens); // a conditional inside `${…}` may carry a class literal
      addTokens(span.literal.text, tokens);
    }
    return;
  }
  if (ts.isParenthesizedExpression(node)) {
    harvest(node.expression, tokens);
    return;
  }
  if (ts.isConditionalExpression(node)) {
    harvest(node.whenTrue, tokens);
    harvest(node.whenFalse, tokens);
    return;
  }
  if (ts.isBinaryExpression(node)) {
    harvest(node.left, tokens); // `cond && 'x'` / `'a' + 'b'` — over-collect both sides
    harvest(node.right, tokens);
    return;
  }
  if (ts.isArrayLiteralExpression(node)) {
    for (const el of node.elements) harvest(el, tokens);
    return;
  }
  if (ts.isObjectLiteralExpression(node)) {
    for (const prop of node.properties) harvestObjectKey(prop, tokens);
    return;
  }
  if (
    ts.isCallExpression(node) &&
    ts.isIdentifier(node.expression) &&
    CLASS_UTIL_CALLEES.has(node.expression.text)
  ) {
    for (const arg of node.arguments) harvest(arg, tokens);
  }
}

/** A clsx object form `{ 'btn-primary': cond, active: x }` — the KEY is the class token. */
function harvestObjectKey(prop: ts.ObjectLiteralElementLike, tokens: Set<string>): void {
  if (!ts.isPropertyAssignment(prop) && !ts.isShorthandPropertyAssignment(prop)) return;
  const name = prop.name;
  if (ts.isIdentifier(name) || ts.isStringLiteralLike(name)) addTokens(name.text, tokens);
}

function addTokens(text: string, tokens: Set<string>): void {
  for (const t of text.split(/\s+/)) {
    if (t.length > 0) tokens.add(t);
  }
}
