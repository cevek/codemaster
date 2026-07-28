// Smallest AST node containing a position — the shared public-API descent
// (`getTokenAtPosition` is compiler-internal). Used by role classification, encloser
// lifting, and declaration-node walking, so it lives in one place.

import ts from 'typescript';

/** The four unarguable function-like kinds — the shared CORE every "is this a function boundary"
 *  question starts from (a nested function's returns / its parameter scope / a climb stop all begin
 *  here). Deliberately NOT the whole set: callers differ on the EXTRAS for sound reasons — a
 *  return-type walk excludes a set-accessor (it has no return type), a climb stop must also break on
 *  a class (a property initializer runs at construction, not under the enclosing branch). So each
 *  caller composes: `isFunctionCore(n) || ts.isClassLike(n) || ts.isSourceFile(n)`. Merging the
 *  extras into one predicate would change behaviour at several call sites. */
export function isFunctionCore(node: ts.Node): boolean {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) ||
    ts.isMethodDeclaration(node)
  );
}

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
