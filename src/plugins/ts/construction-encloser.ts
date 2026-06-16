// The nearest enclosing NAMED declaration that holds or produces a construction-site literal
// — the chainable anchor `construction_sites` reports beside each literal ("which declaration
// builds a T"). Pure AST walk, no domain semantics; split from the scan to keep both under the
// line cap. Sibling spirit to `findEncloser`/`declarationNodeOf`, but tuned for literals: it
// catches a plain `VariableDeclaration` / class `PropertyDeclaration` (the single most common
// construction site, `const defaultUser: User = {…}`) which `findEncloser` deliberately does not.

import ts from 'typescript';
import { qualifyMember } from './encloser-id.ts';

export interface ConstructionEncloser {
  /** Display name — qualified `Class.member` for a class member, the bare name otherwise. */
  name: string;
  /** The BARE name-token text the SymbolId is minted on. It must equal the identifier at
   *  `nameStart`, or the §6 same-symbol check (`text.startsWith(idName, offset)`) fails and the
   *  handle resolves `gone` — so a class member's id uses `make`, never the display `Class.make`
   *  (which navto never reports, breaking rebind). Equals `name` for a non-member. */
  idName: string;
  kind: 'variable' | 'function' | 'method' | 'class' | 'property';
  /** Start offset of the name token — line/col + SymbolId are derived from it by the caller. */
  nameStart: number;
  /** A module-level export (export keyword on the owning statement). Class members read
   *  `false` — they are not module exports. */
  exported: boolean;
}

/** Walk up from `literal` to its nearest enclosing named declaration; `undefined` → the literal
 *  sits at module top level (the caller groups those under the file). The FIRST match wins, so a
 *  literal inside `const u = {…}` reports `u` even when that `const` is itself inside a function
 *  — the nearest binding is the most specific, useful anchor. */
export function enclosingConstruction(literal: ts.Node): ConstructionEncloser | undefined {
  for (let up: ts.Node | undefined = literal.parent; up !== undefined; up = up.parent) {
    if (ts.isVariableDeclaration(up) && ts.isIdentifier(up.name)) {
      // `const X = () => ({…})` reads as a function; exported-ness lives on the
      // VariableStatement (declaration → list → statement).
      const kind = isFunctionInit(up.initializer) ? 'function' : 'variable';
      return mk(up.name.text, up.name, kind, isExported(up.parent.parent));
    }
    if (ts.isPropertyDeclaration(up) && ts.isIdentifier(up.name)) {
      return mk(qualifyMember(up.parent, up.name.text), up.name, 'property', false);
    }
    if (ts.isFunctionDeclaration(up) && up.name !== undefined) {
      return mk(up.name.text, up.name, 'function', isExported(up));
    }
    if (ts.isMethodDeclaration(up) && ts.isIdentifier(up.name)) {
      return mk(qualifyMember(up.parent, up.name.text), up.name, 'method', false);
    }
    if (ts.isClassDeclaration(up) && up.name !== undefined) {
      return mk(up.name.text, up.name, 'class', isExported(up));
    }
  }
  return undefined;
}

/** `nameNode` is the BARE identifier token — its text is the `idName` the SymbolId anchors on,
 *  and its start is `nameStart`; `displayName` may qualify it (`Class.member`) for the human view. */
function mk(
  displayName: string,
  nameNode: ts.Identifier,
  kind: ConstructionEncloser['kind'],
  exported: boolean,
): ConstructionEncloser {
  return {
    name: displayName,
    idName: nameNode.text,
    kind,
    nameStart: nameNode.getStart(),
    exported,
  };
}

function isFunctionInit(init: ts.Expression | undefined): boolean {
  return init !== undefined && (ts.isArrowFunction(init) || ts.isFunctionExpression(init));
}

function isExported(node: ts.Node): boolean {
  const modifiers = ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined;
  return modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) === true;
}
