// Shared statement-level helpers for the LS-driven symbol relocations — `extract_symbol`
// ("Move to a new file", `move-to-file.ts`) and `move_symbol` ("Move to file" into an
// EXISTING dest, `move-to-existing.ts`). Both refactors operate on the SAME unit — the
// top-level statement enclosing the target offset — and both must REFUSE a nested target
// rather than silently act on its enclosing top-level ancestor (§4a / §6). Keeping the range
// computation + nested-target guard in one place means the two ops can never drift apart on
// "what is the symbol the agent pointed at".

import ts from 'typescript';
import { applyEdits } from '../../../../support/text-edits/apply.ts';

/** LS refactor formatting — 2-space, tabs→spaces, shared by both relocations. */
export const REFACTOR_FORMAT: ts.FormatCodeSettings = {
  convertTabsToSpaces: true,
  tabSize: 2,
  indentSize: 2,
};

export const posixDirname = (p: string): string => {
  const i = p.lastIndexOf('/');
  return i < 0 ? '' : p.slice(0, i);
};
export const posixBasename = (p: string): string => {
  const i = p.lastIndexOf('/');
  return i < 0 ? p : p.slice(i + 1);
};

/** Apply LS `TextChange`s to `content` through Stage A's overlap/ordering-safe `applyEdits`. */
export function applyTsChanges(content: string, changes: readonly ts.TextChange[]): string {
  return applyEdits(
    content,
    changes.map((c) => ({
      start: c.span.start,
      end: c.span.start + c.span.length,
      text: c.newText,
    })),
  );
}

/** The top-level statement enclosing `offset`, or undefined if the position isn't on one. */
export function topLevelStatementAt(sf: ts.SourceFile, offset: number): ts.Statement | undefined {
  for (const stmt of sf.statements) {
    if (offset >= stmt.getStart(sf) && offset < stmt.getEnd()) return stmt;
  }
  return undefined;
}

/** A node kind whose NAME an extract/move target can land on (the "thing being declared"). The set
 *  is deliberately broad — it must include every MEMBER kind (class member, enum member,
 *  object-literal property, interface/type member), or a target on one of those would walk past it
 *  to the top-level statement and be mistaken for the top-level symbol. */
function isDeclarationNode(n: ts.Node): boolean {
  return (
    ts.isFunctionDeclaration(n) ||
    ts.isClassDeclaration(n) ||
    ts.isInterfaceDeclaration(n) ||
    ts.isTypeAliasDeclaration(n) ||
    ts.isEnumDeclaration(n) ||
    ts.isModuleDeclaration(n) ||
    ts.isVariableDeclaration(n) ||
    ts.isEnumMember(n) ||
    ts.isPropertyDeclaration(n) ||
    ts.isPropertySignature(n) ||
    ts.isMethodDeclaration(n) ||
    ts.isMethodSignature(n) ||
    ts.isGetAccessorDeclaration(n) ||
    ts.isSetAccessorDeclaration(n) ||
    ts.isConstructorDeclaration(n) ||
    ts.isPropertyAssignment(n) ||
    ts.isShorthandPropertyAssignment(n)
  );
}

/** True when `offset` lands on a declaration NESTED inside `topStmt` (a class/enum/object/interface
 *  MEMBER, or a binding inside a function body) rather than on the top-level statement's own
 *  declaration. The LS "Move to a new file" / "Move to file" refactors extract the ENCLOSING
 *  top-level statement, so without this guard a nested target is silently retargeted to its
 *  top-level ancestor — a DIFFERENT symbol than the agent asked for (spec-stresstest §4a: a nested
 *  `BoundInput` silently moved the whole `useAppForm`; an enum member / object property / class
 *  field would move its whole enum/object/class). Decided by the NEAREST declaration enclosing the
 *  offset: if it is `topStmt` itself OR one of `topStmt`'s own top-level `const`/`let` bindings, the
 *  target IS the top-level symbol; anything deeper is nested. */
export function targetsNestedDeclaration(
  sf: ts.SourceFile,
  offset: number,
  topStmt: ts.Statement,
): boolean {
  const deepest = (node: ts.Node): ts.Node => {
    let found = node;
    node.forEachChild((child) => {
      if (offset >= child.getStart(sf) && offset < child.getEnd()) found = deepest(child);
    });
    return found;
  };
  let node: ts.Node | undefined = deepest(topStmt);
  while (node !== undefined && node !== sf) {
    if (isDeclarationNode(node)) {
      if (node === topStmt) return false; // the top-level statement's own declaration
      // a top-level `const x = …` binding: VariableDeclaration → VariableDeclarationList → topStmt.
      if (ts.isVariableDeclaration(node) && node.parent.parent === topStmt) return false;
      return true; // a deeper declaration (member / inner binding) → nested
    }
    node = node.parent;
  }
  return false; // no declaration encloses the offset — let the LS decide (it will produce no edits)
}
