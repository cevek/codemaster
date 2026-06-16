// The single module-specifier extractor shared by the move/extract import rewriter (`rewrite.ts`)
// and the reverse-capture scanner (`capture/imports.ts`): given an AST node, return the
// string-literal specifier of any module-referencing form — static `import`/`export … from`,
// dynamic `import('…')` / `require('…')`, and `import('…')` in type position. One copy so the
// rewriter and the capture gate can never disagree on WHICH syntactic forms carry a module path
// (a form one walks but the other misses would be a silent rewrite/capture hole).

import ts from 'typescript';

export function moduleSpecifierOf(node: ts.Node): ts.StringLiteral | undefined {
  if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
    return node.moduleSpecifier;
  }
  if (
    ts.isExportDeclaration(node) &&
    node.moduleSpecifier !== undefined &&
    ts.isStringLiteral(node.moduleSpecifier)
  ) {
    return node.moduleSpecifier;
  }
  // `import('./x')` (dynamic) and `require('./x')` (CJS / `import x = require()`).
  if (
    ts.isCallExpression(node) &&
    (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
      (ts.isIdentifier(node.expression) && node.expression.text === 'require')) &&
    node.arguments.length > 0
  ) {
    const arg = node.arguments[0];
    if (arg !== undefined && ts.isStringLiteral(arg)) return arg;
  }
  // `type T = typeof import('./x')` / `import('./x').Foo` in type position.
  if (
    ts.isImportTypeNode(node) &&
    ts.isLiteralTypeNode(node.argument) &&
    ts.isStringLiteral(node.argument.literal)
  ) {
    return node.argument.literal;
  }
  return undefined;
}
