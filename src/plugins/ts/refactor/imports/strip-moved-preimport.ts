// Pre-LS normalizer for `move_symbol`: when the DESTINATION already imports the very symbol being
// moved into it (from the SOURCE module), strip that import BEFORE requesting the LS "Move to file"
// edits. Without it the LS produces two overlapping edits to the SAME `import … from '<source>'`
// statement — remove the moved name, and add the moved symbol's remaining source-module dependency —
// and stock TS asserts `Changes overlap` (surfaced as "cannot move: edits overlap …"), which even the
// §4 rescue fork can't resolve. This is the co-move order-sensitivity root: moving a symbol into a dest
// that references it (a prior co-move step put a referent there) hits the double-edit; leaf-first
// avoided it only by never pre-importing the symbol. Removing the pre-import turns the failing shape
// into the clean one — the LS then emits a single source-module import for the remaining dep and
// relinks the dest's references to the now-local symbol. Co-move needs no leaf-first reorder — the
// un-aliased `{ moved } from '<source>'` shape this targets is exactly what co-move generates.
//
// PRECISE, not name-based: the import is stripped only when its specifier RESOLVES to the source file
// (the symbol actually being moved), never a same-named export from another module. Other specifiers on
// the same statement are preserved (only the moved name is removed). The caller applies the returned
// content to BOTH the dest tree node and the LS overlay it hands the refactor, so edit offsets stay in
// sync (dry==apply). The §2.8 gate remains the backstop.

import ts from 'typescript';
import type { TsProjectHost } from '../../ls-host.ts';
import type { VFSTree } from '../tree/tree.ts';
import type { FsNode } from '../tree/node.ts';
import type { RepoRelPath } from '../../../../core/brands.ts';
import { applyEdits, type TextEdit } from '../../../../support/text-edits/apply.ts';
import { deriveAliasPrefixes } from '../../alias-paths.ts';
import { deleteWholeLine } from '../ast/delete-line.ts';
import { resolveSpecifierToNode } from './resolve.ts';

/** A delete edit for the named `element`, eating the adjacent comma so `{ a, b }` → `{ a }` cleanly.
 *  Removes the preceding comma when not first, else the following comma. */
function removeNamedElement(
  sf: ts.SourceFile,
  elements: readonly ts.ImportSpecifier[],
  index: number,
): TextEdit {
  const el = elements[index];
  if (el === undefined) return { start: 0, end: 0, text: '' };
  if (index > 0) {
    const prev = elements[index - 1];
    if (prev !== undefined) return { start: prev.getEnd(), end: el.getEnd(), text: '' };
  }
  const next = elements[index + 1];
  if (next !== undefined) return { start: el.getStart(sf), end: next.getStart(sf), text: '' };
  return { start: el.getStart(sf), end: el.getEnd(), text: '' };
}

/** True when `target` (a resolved specifier's node) is the source file the symbol is moving FROM. */
function isSource(target: FsNode | null, sourceRel: RepoRelPath): boolean {
  return (
    target !== null && (target.currentPath() === sourceRel || target.initialPath() === sourceRel)
  );
}

/** The dest content with any `import { …, movedName, … } from '<source>'` binding for the moved symbol
 *  removed (whole statement when it was the only binding). Returns `undefined` when nothing was stripped
 *  (the dest doesn't pre-import the moved symbol from source) — the caller then leaves the dest untouched. */
export function stripMovedSymbolPreimport(
  host: TsProjectHost,
  tree: VFSTree,
  options: ts.CompilerOptions,
  destNode: FsNode,
  destContent: string,
  sourceRel: RepoRelPath,
  movedName: string,
): string | undefined {
  const aliasPrefixes = deriveAliasPrefixes(host, options);
  const importerAbs = host.absOf(destNode.currentPath());
  const sf = ts.createSourceFile(
    importerAbs,
    destContent,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  const edits: TextEdit[] = [];
  for (const stmt of sf.statements) {
    if (!ts.isImportDeclaration(stmt) || !ts.isStringLiteral(stmt.moduleSpecifier)) continue;
    const clause = stmt.importClause;
    const bindings = clause?.namedBindings;
    if (clause === undefined || bindings === undefined || !ts.isNamedImports(bindings)) continue;
    // Match the EXPORTED name, un-aliased. `e.name.text` is the LOCAL binding: for `{ x as b }` it is
    // `b` while the export brought in is `x` — matching it would strip an import of a DIFFERENT export
    // that merely renamed to the moved symbol's name, silently re-binding the dest's `b` references to
    // the moved local (a §7 capture the gate can't see). A `{ moved as alias }` (propertyName set) is
    // also skipped: stripping it would strand the dest's `alias` references (the moved decl lands under
    // its own name), so it correctly falls through to the honest overlap refusal. Co-move only ever
    // generates the un-aliased `{ moved }` shape this targets.
    const idx = bindings.elements.findIndex(
      (e) => e.propertyName === undefined && e.name.text === movedName,
    );
    if (idx < 0) continue;
    const target = resolveSpecifierToNode(
      host,
      tree,
      options,
      aliasPrefixes,
      importerAbs,
      stmt.moduleSpecifier.text,
    );
    if (!isSource(target, sourceRel)) continue;
    // Whole statement is exactly `{ movedName }` (no default, no other names) → drop it entirely.
    if (bindings.elements.length === 1 && clause.name === undefined) {
      edits.push(deleteWholeLine(destContent, sf, stmt));
    } else {
      edits.push(removeNamedElement(sf, bindings.elements, idx));
    }
  }
  return edits.length === 0 ? undefined : applyEdits(destContent, edits);
}
