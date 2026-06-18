// A GENERIC syntactic scan of function-like declarations (§5-L2) — the seam the `react` plugin
// (`deps: ['ts']`) consumes to find components / hooks. Domain-NEUTRAL: it reports name + kind +
// export + a TSX-language `returnsJsx` fact (jsx-return.ts); the react CONVENTIONS (PascalCase
// component, `^use[A-Z]` hook) live in plugins/react, never here (§4). Checker-FREE, O(nodes) AST
// (§19) — the literal-calls.ts precedent. Cross-program (programFileGroups): a component declared
// only in a sibling program (`test/**`) is still surfaced, each file scanned once.
//
// Addressing: the name-token `span` (file:line:col) IS a chainable target — `resolveTarget` accepts
// `file+line+col`, so no separate SymbolId is minted (the consumer chains find_usages / rename off
// the span). Anonymous default exports (`export default () => <x/>`) have no name token → not
// reported (documented residual: under-reports, never fabricates). Class components are out of v1
// (not function-like); react detects them separately later.

import ts from 'typescript';
import type { RepoRelPath } from '../../core/brands.ts';
import type { Confidence, Span } from '../../core/span.ts';
import type { TsProjectHost } from './ls-host.ts';
import { programFileGroups } from './program/project-files.ts';
import { spanFromRange } from './spans.ts';
import { classifyJsxReturn } from './jsx-return.ts';

type FunctionDeclKind =
  | 'function' // `function f() {}`
  | 'arrow' // `const f = () => …`
  | 'function-expression' // `const f = function () {}`
  | 'method' // a class method
  | 'call-wrapped'; // `const C = forwardRef(() => <x/>)` — JSX inferred through an unknown wrapper

export type FunctionDecl = {
  /** Bare declared name (the const name for arrow / call-wrapped forms). */
  name: string;
  kind: FunctionDeclKind;
  /** Name-token span (proof + chainable target). */
  span: Span;
  /** A module export — `export`/`export default` on the decl or its owning statement. A separate
   *  `export { X }` / `export default X` statement is NOT followed (residual; under-reports). */
  isExported: boolean;
  /** A JSX node observed in a return position (syntactic — jsx-return.ts). */
  returnsJsx: boolean;
  /** Confidence on `returnsJsx`: direct return/arrow JSX = certain; ternary/`&&` or mixed returns =
   *  partial; wrapper-inferred (call-wrapped) = dynamic. */
  returnsJsxConfidence: Confidence;
};

export type FunctionDeclarationsResult = { decls: FunctionDecl[] };

export function scanFunctionDeclarations(host: TsProjectHost): FunctionDeclarationsResult {
  const decls: FunctionDecl[] = [];
  for (const { files } of programFileGroups(host)) {
    for (const sourceFile of files) {
      if (sourceFile.isDeclarationFile) continue;
      const rel = host.relOf(sourceFile.fileName);
      const visit = (node: ts.Node): void => {
        const decl = classifyDeclaration(sourceFile, rel, node);
        if (decl !== undefined) decls.push(decl);
        ts.forEachChild(node, visit);
      };
      visit(sourceFile);
    }
  }
  return { decls };
}

/** Classify one node as a function-like declaration, or `undefined`. A `const` initializer routes
 *  to arrow / function-expression / call-wrapped; a `function`/method declaration to its kind. */
function classifyDeclaration(
  sourceFile: ts.SourceFile,
  rel: RepoRelPath,
  node: ts.Node,
): FunctionDecl | undefined {
  if (ts.isFunctionDeclaration(node) && node.name !== undefined) {
    const jsx = classifyJsxReturn(node.body);
    return mk(
      sourceFile,
      rel,
      node.name,
      'function',
      hasExport(node),
      jsx.returnsJsx,
      jsx.confidence,
    );
  }
  if (ts.isMethodDeclaration(node) && ts.isIdentifier(node.name)) {
    const jsx = classifyJsxReturn(node.body);
    return mk(sourceFile, rel, node.name, 'method', false, jsx.returnsJsx, jsx.confidence);
  }
  if (
    ts.isVariableDeclaration(node) &&
    ts.isIdentifier(node.name) &&
    node.initializer !== undefined
  ) {
    return classifyVariable(sourceFile, rel, node.name, node.initializer, exportedVar(node));
  }
  return undefined;
}

function classifyVariable(
  sourceFile: ts.SourceFile,
  rel: RepoRelPath,
  name: ts.Identifier,
  init: ts.Expression,
  isExported: boolean,
): FunctionDecl | undefined {
  if (ts.isArrowFunction(init)) {
    const jsx = classifyJsxReturn(init.body);
    return mk(sourceFile, rel, name, 'arrow', isExported, jsx.returnsJsx, jsx.confidence);
  }
  if (ts.isFunctionExpression(init)) {
    const jsx = classifyJsxReturn(init.body);
    return mk(
      sourceFile,
      rel,
      name,
      'function-expression',
      isExported,
      jsx.returnsJsx,
      jsx.confidence,
    );
  }
  if (ts.isCallExpression(init) && wrappedReturnsJsx(init)) {
    // A const whose CallExpression initializer wraps a JSX-returning function (forwardRef / memo /
    // any HOC) — JSX is inferred THROUGH the wrapper, so `dynamic` (we can't prove it forwards it;
    // this is why a `useMemo(() => <x/>)` is honestly dynamic, and react filters it by PascalCase).
    return mk(sourceFile, rel, name, 'call-wrapped', isExported, true, 'dynamic');
  }
  return undefined;
}

/** True iff a call's first function-typed argument returns JSX (the forwardRef/memo shape). */
function wrappedReturnsJsx(call: ts.CallExpression): boolean {
  for (const arg of call.arguments) {
    if (
      (ts.isArrowFunction(arg) || ts.isFunctionExpression(arg)) &&
      classifyJsxReturn(arg.body).returnsJsx
    ) {
      return true;
    }
  }
  return false;
}

function mk(
  sourceFile: ts.SourceFile,
  rel: RepoRelPath,
  name: ts.Identifier,
  kind: FunctionDeclKind,
  isExported: boolean,
  returnsJsx: boolean,
  returnsJsxConfidence: Confidence,
): FunctionDecl {
  return {
    name: name.text,
    kind,
    span: spanFromRange(sourceFile, rel, name.getStart(sourceFile), name.getEnd()),
    isExported,
    returnsJsx,
    returnsJsxConfidence,
  };
}

/** `export` / `export default` modifier on a declaration node. */
function hasExport(node: ts.Node): boolean {
  const modifiers = ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined;
  return modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) === true;
}

/** Export-ness of a `const`/`let`/`var` declaration lives on its owning VariableStatement
 *  (declaration → list → statement); a `for`/`catch` binding has no such statement → false. */
function exportedVar(node: ts.VariableDeclaration): boolean {
  const list = node.parent;
  if (!ts.isVariableDeclarationList(list)) return false;
  const stmt = list.parent;
  return ts.isVariableStatement(stmt) && hasExport(stmt);
}
