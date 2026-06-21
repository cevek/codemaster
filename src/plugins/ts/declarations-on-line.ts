// Named declarations addressed without a column — the data behind two col-less addressing forms
// (resolve-target.ts): `file+line` ("the declaration on that line") and `name+file` ("the
// top-level declaration of this name in that file", rank-independent — never navto-fuzzy). One
// match → resolve it; several → an honest pick-list, never a guessed column (§3/§6/Postel).
//
// Bounded per-file (one AST walk / one top-level statement pass over the requested file's
// SourceFile, §19) — never repo-scaled.

import ts from 'typescript';

/** A named declaration anchored on its bare identifier token. `offset` is the 0-based start of
 *  that identifier (what every downstream symbol-addressed read funnels through), `line`/`col`
 *  are 1-based for the honest pick-list message. */
export interface DeclOnLine {
  name: string;
  kind: string;
  offset: number;
  line: number;
  col: number;
}

/** Declaration kinds that introduce an addressable named symbol (each is a `ts.NamedDeclaration`,
 *  so `getNameOfDeclaration` is type-safe on it). Binding-pattern / computed / string names fall
 *  out below via the `isIdentifier` guard — only a bare identifier is an addressable anchor. */
function isTargetableDeclaration(node: ts.Node): node is ts.NamedDeclaration {
  return (
    ts.isVariableDeclaration(node) ||
    ts.isFunctionDeclaration(node) ||
    ts.isClassDeclaration(node) ||
    ts.isInterfaceDeclaration(node) ||
    ts.isTypeAliasDeclaration(node) ||
    ts.isEnumDeclaration(node) ||
    ts.isEnumMember(node) ||
    ts.isModuleDeclaration(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isMethodSignature(node) ||
    ts.isPropertyDeclaration(node) ||
    ts.isPropertySignature(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node)
  );
}

/** A short kind label for the honest pick-list (a `const`/`let`/`var` split for variables, the
 *  syntactic kind otherwise). Display-only — never used for resolution. */
function kindLabel(node: ts.Node): string {
  if (ts.isVariableDeclaration(node)) {
    const flags = node.parent.flags;
    if ((flags & ts.NodeFlags.Const) !== 0) return 'const';
    if ((flags & ts.NodeFlags.Let) !== 0) return 'let';
    return 'var';
  }
  if (ts.isFunctionDeclaration(node)) return 'function';
  if (ts.isClassDeclaration(node)) return 'class';
  if (ts.isInterfaceDeclaration(node)) return 'interface';
  if (ts.isTypeAliasDeclaration(node)) return 'type';
  if (ts.isEnumDeclaration(node)) return 'enum';
  if (ts.isEnumMember(node)) return 'enum-member';
  if (ts.isModuleDeclaration(node)) return 'namespace';
  if (ts.isMethodDeclaration(node) || ts.isMethodSignature(node)) return 'method';
  if (ts.isGetAccessorDeclaration(node)) return 'getter';
  if (ts.isSetAccessorDeclaration(node)) return 'setter';
  return 'property';
}

/** Build a `DeclOnLine` off a named declaration, anchored on its bare identifier token;
 *  `undefined` when the name is not a plain identifier (binding pattern / computed / string). */
function toDeclOnLine(node: ts.NamedDeclaration, sf: ts.SourceFile): DeclOnLine | undefined {
  const nameNode = ts.getNameOfDeclaration(node);
  if (nameNode === undefined || !ts.isIdentifier(nameNode)) return undefined;
  const offset = nameNode.getStart(sf);
  const lc = sf.getLineAndCharacterOfPosition(offset);
  return {
    name: nameNode.text,
    kind: kindLabel(node),
    offset,
    line: lc.line + 1,
    col: lc.character + 1,
  };
}

/** Every named declaration whose identifier token starts on `line` (1-based), in source order.
 *  Empty when the line holds no declaration (out-of-range or a non-declaration line). */
export function declarationsOnLine(sf: ts.SourceFile, line: number): DeclOnLine[] {
  const out: DeclOnLine[] = [];
  const visit = (node: ts.Node): void => {
    if (isTargetableDeclaration(node)) {
      const d = toDeclOnLine(node, sf);
      if (d !== undefined && d.line === line) out.push(d);
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(sf, visit);
  return out;
}

/** Every TOP-LEVEL declaration in `sf` named exactly `name` (rank-independent — a direct AST
 *  pass over the file's statements, never navto's fuzzy case-insensitive ranking). A
 *  `VariableStatement`'s identifier declarators count as top-level; nested locals are excluded.
 *  Usually one; >1 (same name declared twice at top level) is returned for an honest pick-list. */
export function topLevelDeclarationsNamed(sf: ts.SourceFile, name: string): DeclOnLine[] {
  const out: DeclOnLine[] = [];
  for (const stmt of sf.statements) {
    if (ts.isVariableStatement(stmt)) {
      for (const d of stmt.declarationList.declarations) {
        if (ts.isIdentifier(d.name) && d.name.text === name) {
          const decl = toDeclOnLine(d, sf);
          if (decl !== undefined) out.push(decl);
        }
      }
    } else if (isTargetableDeclaration(stmt)) {
      const decl = toDeclOnLine(stmt, sf);
      if (decl !== undefined && decl.name === name) out.push(decl);
    }
  }
  return out;
}
