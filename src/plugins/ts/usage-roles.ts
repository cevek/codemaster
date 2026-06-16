// Reference-site classification + enclosing-declaration rollup — pure AST work, no
// domain semantics. `role` says WHAT a reference syntactically is (`<X/>` vs `X()` vs
// a type position vs an import); `findEncloser` lifts a reference to its nearest
// enclosing NAMED declaration — the universal "which component/function uses X"
// answer, formulated as an AST concept.

import ts from 'typescript';
import { nodeAt } from './ast-node.ts';

/** Syntactic role of one reference site. `decl` = the definition itself. `reexport` =
 *  an `export { X }` / `export { X } from …` barrel specifier — structurally load-bearing
 *  (the module's public surface), so it is never collapsed away like a plain `import`.
 *  `jsx-closing` is internal: the `</X>` half of an element already counted at its
 *  opening tag — consumers drop it so counts mean "JSX elements", not tag tokens. */
export type UsageRole = 'jsx' | 'call' | 'type' | 'import' | 'reexport' | 'write' | 'read' | 'decl';
export type ClassifiedRole = UsageRole | 'jsx-closing';

export const USAGE_ROLES = [
  'jsx',
  'call',
  'type',
  'import',
  'reexport',
  'write',
  'read',
  'decl',
] as const;

export function classifyRole(
  sourceFile: ts.SourceFile,
  position: number,
  flags: { isDefinition: boolean; isWrite: boolean },
): ClassifiedRole {
  if (flags.isDefinition) return 'decl';
  const node = nodeAt(sourceFile, position);
  if (node === undefined) return flags.isWrite ? 'write' : 'read';

  for (let up: ts.Node | undefined = node; up !== undefined; up = up.parent) {
    // A barrel specifier (`export { X }` / `export { X } from './y'`) is a re-export —
    // load-bearing module surface, kept distinct from `import` so it is never collapsed.
    if (ts.isExportSpecifier(up)) return 'reexport';
    if (
      ts.isImportDeclaration(up) ||
      ts.isImportSpecifier(up) ||
      ts.isImportClause(up) ||
      ts.isImportEqualsDeclaration(up)
    ) {
      return 'import';
    }
    if (ts.isJsxOpeningElement(up) || ts.isJsxSelfClosingElement(up)) {
      // Only the tag name itself is a 'jsx' usage; a reference inside an attribute
      // expression keeps its own role and falls through on a later ancestor.
      if (within(up.tagName, position)) return 'jsx';
    }
    if (ts.isJsxClosingElement(up) && within(up.tagName, position)) return 'jsx-closing';
    if (ts.isTypeNode(up) || ts.isHeritageClause(up) || ts.isTypeQueryNode(up)) return 'type';
    // A member-signature NAME inside an `interface`/type-literal (`m(): void`, `p: T`,
    // `get x(): T` / `set x(v)`) is a TYPE-level declaration, not a value read/write.
    // `findReferences` links such a signature to an implementing/structurally-matching
    // value symbol, so the occurrence arrives here with `isDefinition:false` and would
    // otherwise fall through to `read` — a spurious value-read that `impact` mistakes for
    // a dynamic-dispatch escape. It lives in a type position, so it is a `type` usage. A
    // COMPUTED name (`[expr]: T`) keeps its own role — `expr` is a genuine value read.
    // `MethodSignature`/`PropertySignature` only ever appear as type members; an
    // accessor SIGNATURE also has the value-context form (a class accessor), so it counts
    // only when its parent is an interface/type-literal — a class accessor stays decl/read.
    if (
      isTypeMemberSignature(up) &&
      !ts.isComputedPropertyName(up.name) &&
      within(up.name, position)
    ) {
      return 'type';
    }
    if ((ts.isCallExpression(up) || ts.isNewExpression(up)) && within(up.expression, position)) {
      return 'call';
    }
    if (ts.isStatement(up)) break; // role context never crosses a statement boundary
  }
  return flags.isWrite ? 'write' : 'read';
}

/** A NAMED member signature of an `interface`/type-literal — a TYPE-level member
 *  declaration, never a value binding. `MethodSignature`/`PropertySignature` are type
 *  members by construction (a class uses `MethodDeclaration`/`PropertyDeclaration`); an
 *  accessor signature also has a value-context form (a class `get`/`set`), so it counts
 *  only when its parent is the type context — a class accessor stays decl/read/write. */
function isTypeMemberSignature(
  node: ts.Node,
): node is
  | ts.MethodSignature
  | ts.PropertySignature
  | ts.GetAccessorDeclaration
  | ts.SetAccessorDeclaration {
  if (ts.isMethodSignature(node) || ts.isPropertySignature(node)) return true;
  if (ts.isGetAccessorDeclaration(node) || ts.isSetAccessorDeclaration(node)) {
    return ts.isInterfaceDeclaration(node.parent) || ts.isTypeLiteralNode(node.parent);
  }
  return false;
}

export interface Encloser {
  name: string;
  /** `const`/`variable` = a top-level non-function value binding (`const b = a()`,
   *  `let cfg = {…}`) — distinct from `function` so a data binding never reads as
   *  callable. A function-valued binding stays `function`. */
  kind: 'function' | 'method' | 'class' | 'module' | 'const' | 'variable';
  /** Start of the encloser's name token. */
  start: number;
  exported: boolean;
}

/** Nearest enclosing named declaration of a position; `undefined` → module top level
 *  (the caller groups those under the file itself). */
export function findEncloser(sourceFile: ts.SourceFile, position: number): Encloser | undefined {
  const node = nodeAt(sourceFile, position);
  for (let up: ts.Node | undefined = node; up !== undefined; up = up.parent) {
    if (ts.isFunctionDeclaration(up) && up.name !== undefined) {
      return encloser(up.name.text, 'function', up.name, up);
    }
    if (ts.isMethodDeclaration(up) && ts.isIdentifier(up.name)) {
      const cls = up.parent;
      const clsName =
        ts.isClassDeclaration(cls) && cls.name !== undefined ? `${cls.name.text}.` : '';
      return encloser(`${clsName}${up.name.text}`, 'method', up.name, up);
    }
    if (ts.isClassDeclaration(up) && up.name !== undefined && !within(up.name, position)) {
      return encloser(up.name.text, 'class', up.name, up);
    }
    if (ts.isVariableDeclaration(up) && ts.isIdentifier(up.name)) {
      const initializer = up.initializer;
      const isFn =
        initializer !== undefined &&
        (ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer));
      // A reference INSIDE a function-valued binding's body belongs to that function —
      // `const Foo = () => …`; exported-ness lives on the VariableStatement.
      if (isFn && within(initializer, position)) {
        return encloser(up.name.text, 'function', up.name, up.parent.parent);
      }
      // Otherwise: a TOP-LEVEL non-function value binding (`export const b = a()`,
      // `const cfg = { f: dep }`) is its own encloser, so a reference in its initializer
      // rolls up to a re-resolvable `name@file:line:col` SymbolId instead of the module
      // node. Scoped to module top level: a nested local `const` is not a useful
      // re-resolvable encloser — its refs belong to the enclosing function/method, so we
      // keep walking up. Function-valued bindings stay handled by the branch above (their
      // body refs roll to the function; the name/decl ref keeps the prior module rollup).
      if (!isFn) {
        const statement = topLevelVariableStatement(up);
        if (statement !== undefined) {
          const kind = isConst(statement) ? 'const' : 'variable';
          return encloser(up.name.text, kind, up.name, statement);
        }
      }
    }
  }
  return undefined;
}

/** The `VariableStatement` of `decl` iff it sits at module top level (its parent is the
 *  SourceFile) — i.e. a re-resolvable module-scope binding. `undefined` for a nested
 *  binding, a `for (const …)` head (parent is the loop, not a VariableStatement), or a
 *  namespace-nested one. */
function topLevelVariableStatement(decl: ts.VariableDeclaration): ts.VariableStatement | undefined {
  const list = decl.parent;
  if (!ts.isVariableDeclarationList(list)) return undefined;
  const statement = list.parent;
  if (!ts.isVariableStatement(statement)) return undefined;
  return ts.isSourceFile(statement.parent) ? statement : undefined;
}

function isConst(statement: ts.VariableStatement): boolean {
  return (statement.declarationList.flags & ts.NodeFlags.Const) !== 0;
}

function encloser(
  name: string,
  kind: Encloser['kind'],
  nameNode: ts.Node,
  declaration: ts.Node,
): Encloser {
  return { name, kind, start: nameNode.getStart(), exported: isExported(declaration) };
}

function isExported(node: ts.Node): boolean {
  const modifiers = ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined;
  return modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) === true;
}

function within(node: ts.Node, position: number): boolean {
  return node.getStart() <= position && position < node.getEnd();
}
