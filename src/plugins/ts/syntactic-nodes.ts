// Pure, project-agnostic classifiers over a `getNamedDeclarations` node — shared by the three
// no-program syntactic paths (t-515730 / t-143952 / t-229522): the fuzzy `search_symbol
// { syntactic: true }` scan, the `symbols_overview` catalogue, and the `source { syntactic: true }`
// declaration reader. Syntactic only (no checker): they read the AST node, never a type.
// Kept in one module so the consumers can never drift on what counts as an import / a real decl /
// an export (the copy-paste risk the extraction removes) — and because `isRealDeclaration` is
// load-bearing for more than ranking: it is what stops `source` printing an import line as a body.

import ts from 'typescript';

/** The 0-based start of the declaration's NAME token — the anchor every symbol-addressed read
 *  funnels through. Fixes navto's `declText.indexOf(name)` imprecision (which mis-anchors
 *  `X as Yprefix` and expando assignments). Falls back to the node start when the name is not a
 *  plain identifier (computed / string / binding name). */
export function nameAnchor(node: ts.Declaration, sf: ts.SourceFile): number {
  const nameNode = ts.getNameOfDeclaration(node);
  return (nameNode ?? node).getStart(sf);
}

/** Real declaration (introduces a symbol) vs an import / re-export re-mention of a name declared
 *  elsewhere. Real decls rank FIRST so a result cap shows definitions, import noise falls into the
 *  truncated tail — and, for `source`, a non-real node has no body to print at all. */
export function isRealDeclaration(node: ts.Node): boolean {
  // A bare IDENTIFIER is never a declaration in this set. TS's `computeNamedDeclarations` passes the
  // declaration NODE for every real declaration; the one place it adds a plain identifier is the
  // DEFAULT-import binding (`addDeclaration(importClause.name)` — `import X from './y'`). Kind-listing
  // the import wrappers therefore misses that shape entirely: `X` read as a real declaration, so
  // `source` printed the import line as X's body and every default-exported symbol read as N
  // declarations in N importing files. The identifier check is the general form of the same rule, not
  // a patch for one shape — no real declaration reaches this set as an identifier.
  if (ts.isIdentifier(node)) return false;
  return !(isImportSite(node) || ts.isExportSpecifier(node) || ts.isNamespaceExport(node));
}

/** A pure IMPORT re-mention (never an export). `export {X}` / `export * as ns` are export-specifiers,
 *  NOT imports, so they are NOT flagged here. The DEFAULT-import binding is a bare identifier rather
 *  than any of these kinds — `isRealDeclaration` is what excludes it. */
export function isImportSite(node: ts.Node): boolean {
  return (
    ts.isImportClause(node) ||
    ts.isImportSpecifier(node) ||
    ts.isImportEqualsDeclaration(node) ||
    ts.isNamespaceImport(node)
  );
}

/** Syntactic "is this declaration part of the module's EXPORTED surface?" — no checker, so it reads
 *  the AST: an `export`/`export default` modifier (getCombinedModifierFlags walks a var-decl up to its
 *  statement), or a re-export node (`export {X}` / `export * as ns`). This is PRECISE for a top-level
 *  export and correctly EXCLUDES a non-exported local, an enum member, and a class/interface member
 *  (none carry the modifier) — so `symbols_overview`' default `exportedOnly` shows the public surface, not
 *  every local. It cannot see a name exported ONLY via a separate `export { X }` FROM the decl node
 *  itself, but getNamedDeclarations also yields that export-specifier node (caught by the second arm),
 *  so the name still appears. Still syntactic (no checker) — disclosed by the op. */
export function isExportedDeclaration(node: ts.Node): boolean {
  if (ts.isExportSpecifier(node) || ts.isNamespaceExport(node)) return true;
  const flags = ts.getCombinedModifierFlags(node as ts.Declaration);
  return (flags & (ts.ModifierFlags.Export | ts.ModifierFlags.Default)) !== 0;
}

/** A type/class/enum MEMBER declaration (method / accessor / property / enum member / constructor /
 *  parameter) — a sub-symbol, never a module-level declaration in its own right. `symbols_overview`
 *  excludes these: the orientation catalogue lists TOP-LEVEL declared names (the class, not its
 *  methods), and a member never carries an export modifier so it could never satisfy the default
 *  `exportedOnly` — surfacing an advertised member `kind` as a confident empty would be a §3.4 lie. */
export function isMemberDeclaration(node: ts.Node): boolean {
  return (
    ts.isMethodDeclaration(node) ||
    ts.isMethodSignature(node) ||
    ts.isPropertyDeclaration(node) ||
    ts.isPropertySignature(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node) ||
    ts.isConstructorDeclaration(node) ||
    ts.isEnumMember(node) ||
    ts.isParameter(node)
  );
}

/** A ScriptElementKind-ish label for a `getNamedDeclarations` node — the full node variety incl
 *  import/export aliases + a SyntaxKind fallback. Kept DELIBERATELY DISTINCT from
 *  `declarations-on-line.ts`'s addressing-only `kindLabel` (which emits `namespace` / `enum-member`):
 *  this vocabulary (`module` / `enum member`) is a USER-FACING contract — the `kind:` filter value for
 *  `symbols_overview` and the reported kind for `search_symbol` — so a naive DRY-merge to the display
 *  labeler would silently break the documented `kind` filter (a §3.4 regression). Not to be unified. */
export function nodeKindLabel(node: ts.Node): string {
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
  if (ts.isEnumMember(node)) return 'enum member';
  if (ts.isModuleDeclaration(node)) return 'module';
  if (ts.isMethodDeclaration(node) || ts.isMethodSignature(node)) return 'method';
  if (ts.isGetAccessorDeclaration(node)) return 'getter';
  if (ts.isSetAccessorDeclaration(node)) return 'setter';
  if (ts.isPropertyDeclaration(node) || ts.isPropertySignature(node)) return 'property';
  if (!isRealDeclaration(node)) return 'alias';
  return 'declaration';
}
