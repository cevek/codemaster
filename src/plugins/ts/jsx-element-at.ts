// The one JSX-element locator shared by every symbol-anchored JSX scan: from a tag-NAME token
// position (what the LS hands back as a `jsx`-role reference) up to the element that owns it.
// Lives on its own so `jsx-call-sites.ts` (which props a site PASSES) and `jsx-attr-values.ts`
// (WHAT those props are) read the same element — two spellings of "the enclosing element" is how
// the two scans would silently disagree about what a site is.

import ts from 'typescript';

/** Nearest enclosing JSX opening / self-closing element from a tag-name position; `undefined`
 *  past a statement boundary (a jsx ref is always inside its own element, so this terminates). */
export function enclosingJsxOpening(
  node: ts.Node,
): ts.JsxOpeningElement | ts.JsxSelfClosingElement | undefined {
  for (let up: ts.Node | undefined = node; up !== undefined; up = up.parent) {
    if (ts.isJsxOpeningElement(up) || ts.isJsxSelfClosingElement(up)) return up;
    if (ts.isStatement(up)) return undefined;
  }
  return undefined;
}
