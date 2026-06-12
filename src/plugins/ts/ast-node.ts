// Smallest AST node containing a position — the shared public-API descent
// (`getTokenAtPosition` is compiler-internal). Used by role classification, encloser
// lifting, and declaration-node walking, so it lives in one place.

import ts from 'typescript';

/** Smallest node containing `position`; `undefined` only when `position` is outside the
 *  file (the descent never returns the SourceFile itself). */
export function nodeAt(sourceFile: ts.SourceFile, position: number): ts.Node | undefined {
  let current: ts.Node = sourceFile;
  for (;;) {
    const child = ts.forEachChild(current, (c) =>
      c.getStart(sourceFile) <= position && position < c.getEnd() ? c : undefined,
    );
    if (child === undefined) return current === sourceFile ? undefined : current;
    current = child;
  }
}
