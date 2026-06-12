// Reference-site classification + enclosing-declaration rollup — pure AST work, no
// domain semantics. `role` says WHAT a reference syntactically is (`<X/>` vs `X()` vs
// a type position vs an import); `findEncloser` lifts a reference to its nearest
// enclosing NAMED declaration — the universal "which component/function uses X"
// answer, formulated as an AST concept.

import ts from 'typescript';

/** Syntactic role of one reference site. `decl` = the definition itself.
 *  `jsx-closing` is internal: the `</X>` half of an element already counted at its
 *  opening tag — consumers drop it so counts mean "JSX elements", not tag tokens. */
export type UsageRole = 'jsx' | 'call' | 'type' | 'import' | 'write' | 'read' | 'decl';
export type ClassifiedRole = UsageRole | 'jsx-closing';

export const USAGE_ROLES = ['jsx', 'call', 'type', 'import', 'write', 'read', 'decl'] as const;

export function classifyRole(
  sourceFile: ts.SourceFile,
  position: number,
  flags: { isDefinition: boolean; isWrite: boolean },
): ClassifiedRole {
  if (flags.isDefinition) return 'decl';
  const node = nodeAt(sourceFile, position);
  if (node === undefined) return flags.isWrite ? 'write' : 'read';

  for (let up: ts.Node | undefined = node; up !== undefined; up = up.parent) {
    if (
      ts.isImportDeclaration(up) ||
      ts.isImportSpecifier(up) ||
      ts.isImportClause(up) ||
      ts.isExportSpecifier(up) ||
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
    if ((ts.isCallExpression(up) || ts.isNewExpression(up)) && within(up.expression, position)) {
      return 'call';
    }
    if (ts.isStatement(up)) break; // role context never crosses a statement boundary
  }
  return flags.isWrite ? 'write' : 'read';
}

export interface Encloser {
  name: string;
  kind: 'function' | 'method' | 'class' | 'module';
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
    if (
      ts.isVariableDeclaration(up) &&
      ts.isIdentifier(up.name) &&
      up.initializer !== undefined &&
      (ts.isArrowFunction(up.initializer) || ts.isFunctionExpression(up.initializer)) &&
      within(up.initializer, position)
    ) {
      // `const Foo = () => …` — exported-ness lives on the VariableStatement.
      const statement = up.parent.parent;
      return encloser(up.name.text, 'function', up.name, statement);
    }
  }
  return undefined;
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

/** Smallest node containing `position` (public-API descent; `getTokenAtPosition` is
 *  compiler-internal). */
function nodeAt(sourceFile: ts.SourceFile, position: number): ts.Node | undefined {
  let current: ts.Node = sourceFile;
  for (;;) {
    const child = ts.forEachChild(current, (c) =>
      c.getStart(sourceFile) <= position && position < c.getEnd() ? c : undefined,
    );
    if (child === undefined) return current === sourceFile ? undefined : current;
    current = child;
  }
}
