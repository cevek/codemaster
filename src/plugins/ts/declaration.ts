// Declaration-node resolution (§3.1). The LS definition `textSpan` covers only the NAME
// token, so `find_definition` could echo the identifier even at full verbosity — the body
// wasn't in the data. `declarationNodeOf` walks up from the name token to the enclosing
// declaration node, so a span built from it carries the WHOLE declaration. Same walking
// spirit as `findEncloser`, but it returns the full node (and stops at the statement that
// carries the `export` modifier + trailing `;` for `const X = …`).

import ts from 'typescript';
import { nodeAt } from './ast-node.ts';

/** The enclosing declaration node for the symbol whose name token sits at `namePos`, or
 *  `undefined` when the position isn't inside one (the caller falls back to the name span).
 *  For an arrow/function-expression `const`, this is the `VariableStatement` — it carries
 *  the `export` modifier and the trailing `;`, which the byte-range oracle checks for. */
export function declarationNodeOf(sourceFile: ts.SourceFile, namePos: number): ts.Node | undefined {
  const node = nodeAt(sourceFile, namePos);
  for (let up: ts.Node | undefined = node; up !== undefined; up = up.parent) {
    if (
      ts.isFunctionDeclaration(up) ||
      ts.isClassDeclaration(up) ||
      ts.isInterfaceDeclaration(up) ||
      ts.isTypeAliasDeclaration(up) ||
      ts.isEnumDeclaration(up) ||
      ts.isMethodDeclaration(up) ||
      ts.isMethodSignature(up) ||
      ts.isPropertySignature(up) ||
      ts.isPropertyDeclaration(up) ||
      ts.isModuleDeclaration(up)
    ) {
      return up;
    }
    // `const X = …` / `let` / `var`: lift past the declaration + list to the statement,
    // which owns the `export` keyword and the trailing `;`.
    if (ts.isVariableStatement(up)) return up;
    // Don't cross out of the declaration into its container's body.
    if (ts.isSourceFile(up)) break;
  }
  return undefined;
}
