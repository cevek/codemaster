// The `find_usages {name, file}` member/re-export fallback (t-755152): a bare name+file that
// resolves NO top-level declaration is not a dead-end — the name may be a class/interface/type-literal
// MEMBER, an enum member, or a re-exported/imported binding IN that file. This locates those
// non-top-level bindings so the op can re-issue by position (and disclose the resolution), instead of
// telling the agent to hand-compute file:line:col or fall back to grep.
//
// Bounded per-file (one AST walk over the requested file's SourceFile, §19) — never repo-scaled. It
// resolves a POSITION only; the reference discovery still rides the one `findReferencesAcross`
// primitive `find_usages` uses (alias-safe, follows a re-export specifier to its target).

import ts from 'typescript';
import type { RepoRelPath } from '../../core/brands.ts';
import type { TsProjectHost } from './ls-host.ts';
import { kindLabel } from './declarations-on-line.ts';

/** One non-top-level binding of a name in a file — a chainable position (`offset` is the 0-based
 *  start of the name token, `line`/`col` are 1-based) plus its containing type/module for an honest
 *  disclosure and a `member_usages` redirect. */
export interface MemberInFile {
  name: string;
  kind: string;
  offset: number;
  line: number;
  col: number;
  /** The enclosing type/class/interface/enum name (a member) or the module specifier (a
   *  re-export/import). Absent for a local re-export with no `from`. */
  container?: string;
}

/** A type/class member declaration whose name is an addressable identifier anchor. */
function isMemberDeclaration(node: ts.Node): node is ts.NamedDeclaration {
  return (
    ts.isMethodDeclaration(node) ||
    ts.isMethodSignature(node) ||
    ts.isPropertyDeclaration(node) ||
    ts.isPropertySignature(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node)
  );
}

/** Nearest enclosing named type container (class / interface / type-alias / enum). */
function containerName(node: ts.Node): string | undefined {
  let cur: ts.Node | undefined = node.parent;
  while (cur !== undefined) {
    if (
      (ts.isClassDeclaration(cur) ||
        ts.isInterfaceDeclaration(cur) ||
        ts.isTypeAliasDeclaration(cur) ||
        ts.isEnumDeclaration(cur)) &&
      cur.name !== undefined
    ) {
      return cur.name.text;
    }
    cur = cur.parent;
  }
  return undefined;
}

/** The `from './y'` module of an export/import specifier, when present (a plain string literal). */
function specifierModule(node: ts.ExportSpecifier | ts.ImportSpecifier): string | undefined {
  const decl = ts.isExportSpecifier(node)
    ? node.parent.parent // NamedExports → ExportDeclaration
    : node.parent.parent.parent; // NamedImports → ImportClause → ImportDeclaration
  const mod =
    ts.isExportDeclaration(decl) || ts.isImportDeclaration(decl) ? decl.moduleSpecifier : undefined;
  return mod !== undefined && ts.isStringLiteral(mod) ? mod.text : undefined;
}

function push(
  out: MemberInFile[],
  sf: ts.SourceFile,
  nameNode: ts.Identifier,
  kind: string,
  container: string | undefined,
): void {
  const offset = nameNode.getStart(sf);
  const lc = sf.getLineAndCharacterOfPosition(offset);
  out.push({
    name: nameNode.text,
    kind,
    offset,
    line: lc.line + 1,
    col: lc.character + 1,
    ...(container !== undefined ? { container } : {}),
  });
}

/** Every NON-top-level binding named exactly `name` in `sf`: class/interface/type-literal members,
 *  enum members, and export/import specifiers (re-exports). Top-level declarations are NOT collected
 *  (they are `topLevelDeclarationsNamed`'s job — this fallback runs only after that found none). Nested
 *  function/variable LOCALS are excluded — they are not addressable members. Usually one; >1 is an
 *  honest pick-list. */
export function nonTopLevelDeclarationsNamed(sf: ts.SourceFile, name: string): MemberInFile[] {
  const out: MemberInFile[] = [];
  const visit = (node: ts.Node): void => {
    if (isMemberDeclaration(node)) {
      const nameNode = ts.getNameOfDeclaration(node);
      if (nameNode !== undefined && ts.isIdentifier(nameNode) && nameNode.text === name) {
        push(out, sf, nameNode, kindLabel(node), containerName(node));
      }
    } else if (ts.isEnumMember(node)) {
      if (ts.isIdentifier(node.name) && node.name.text === name) {
        push(out, sf, node.name, 'enum-member', containerName(node));
      }
    } else if (ts.isExportSpecifier(node) || ts.isImportSpecifier(node)) {
      // `.name` is the local-facing name (the `B` of `export { A as B }`) — what the agent addresses
      // in this file. It is a `ModuleExportName`, so guard for a plain identifier (a string-literal
      // export name `export { "x" as y }` is not an addressable identifier anchor).
      if (ts.isIdentifier(node.name) && node.name.text === name) {
        const mod = specifierModule(node);
        const kind = ts.isImportSpecifier(node)
          ? 'import'
          : mod !== undefined
            ? 're-export'
            : 'export';
        push(out, sf, node.name, kind, mod);
      }
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(sf, visit);
  return out;
}

/** Host wrapper: resolve `file` to its SourceFile (across all programs — a `test/**` file lives only
 *  in a sibling program), then scan. A `string` when the file is not in the project. */
export function membersNamedInFile(
  h: TsProjectHost,
  name: string,
  file: string,
): MemberInFile[] | string {
  const abs = h.absOf(file as RepoRelPath);
  const sf = h.sourceFileAcross(abs)?.sf;
  if (sf === undefined) return `file not in the TS project: ${file}`;
  return nonTopLevelDeclarationsNamed(sf, name);
}
